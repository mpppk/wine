import { env } from "cloudflare:workers";
import { LangfuseClient } from "@langfuse/client";
import {
	checkTemplateVariables,
	compileFallbackTemplate,
	hasUnresolvedPlaceholders,
	type ManagedPromptDefinition,
} from "#/lib/ai/managed-prompts";
import { errToString, logWarn } from "#/lib/logger";
import { LANGFUSE_BASE_URL, readLangfuseKeys } from "./langfuse";
import { resolveServerEnvironment } from "./sentry-envelope";

// Langfuse から**取る**唯一の入口(#512 Phase 4)。`langfuse.ts` が「出す唯一の入口」
// なのと対になる。`ai-service.ts` に `LangfuseClient` を直書きしない —— 経路ごとに
// 書くと、後から足した経路でガードとラベル解決が漏れる(#166 / #174 と同じ形)。
//
// この Phase から**プロンプト本文のSSOTは Langfuse 側**にある。コードの
// `MANAGED_PROMPTS` は fallback と初期登録の種であって、正ではない。
// 「デプロイと無関係に挙動が変わる」ことを許容した代わりに、次の3つで御する:
//
//  1. ラベル(`production` / `preview`)で本番と評価中を分ける
//  2. 実行時ガードで壊れた版を弾き、コードの fallback へ落とす
//  3. どの版で動いたかを generation の prompt link と `metadata.promptSource` に残す

/** プロンプトの版を選ぶラベル。 */
export type ManagedPromptLabel = "production" | "preview";

/**
 * プロンプト本文の由来。generation の `metadata.promptSource` に載せる。
 *
 * `langfuse` 以外は「コードの fallback で動いた」ことを意味する。**この値が
 * `code-invalid-template` で埋まっていたら Langfuse 側の版が壊れている**、という
 * 読み方をする(トレースが唯一の気付き口になるので、握りつぶさず必ず残す)。
 */
type ManagedPromptSource =
	| "langfuse"
	| "code-no-keys"
	| "code-fetch-failed"
	| "code-invalid-template";

export interface ManagedPromptResult {
	/** 変数を埋め終わった本文。呼び出し側はこれだけを使う。 */
	text: string;
	/**
	 * generation に載せる版へのリンク。fallback で動いた回は `null`。
	 * `@langfuse/tracing` は `isFallback` が真だと prompt 属性を丸ごと落とすので、
	 * ここを `null` にしておけば fallback の回が版ごとの指標を汚さない。
	 */
	ref: { name: string; version: number; isFallback: boolean } | null;
	source: ManagedPromptSource;
}

// Cloudflare Workers の isolate 内で1回だけ初期化する(`langfuse.ts` と同じ流儀)。
let client: LangfuseClient | null = null;

/**
 * 引くラベルを実行環境から決める。**環境判定を発明せず** `langfuse.ts` の
 * `environment` と同じ `resolveServerEnvironment()` を流用する。
 *
 * 本番だけが `production`。プレビューとローカルは `preview` を引くので、
 * 「Langfuse で編集した版に preview ラベルを張る」だけで本番を触らずに試せる。
 * preview ラベルの版が無ければ Langfuse は 404 を返し、コードの fallback に落ちる
 * —— つまり**ラベルを張ったときだけ本番と違う挙動になる**。
 */
export function resolvePromptLabel(): ManagedPromptLabel {
	const e = resolveServerEnvironment(
		(env as unknown as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL,
	);
	return e === "production" ? "production" : "preview";
}

function ensureClient(): LangfuseClient | null {
	const keys = readLangfuseKeys();
	if (!keys) return null;
	if (client) return client;
	client = new LangfuseClient({
		publicKey: keys.publicKey,
		secretKey: keys.secretKey,
		baseUrl: LANGFUSE_BASE_URL,
	});
	return client;
}

function fallbackResult(
	definition: ManagedPromptDefinition,
	variables: Record<string, string>,
	source: ManagedPromptSource,
): ManagedPromptResult {
	return {
		text: compileFallbackTemplate(definition.template, variables),
		ref: null,
		source,
	};
}

/**
 * Langfuse で管理しているプロンプトを取得し、変数を差し込んで返す。
 *
 * **例外を投げない。** 取得できなければコードの fallback へ落ちる(キー未設定なら
 * 外向き fetch を1本も出さない)。計装や設定の失敗で推論そのものを壊さない、という
 * `recordGeneration` と同じ原則。
 *
 * 呼び出しは**クレジットの予約より前**に置くこと。予約の後・try の外で await すると、
 * その throw が返却処理へ届かない(`ai-service.ts` のモデル解決と同じ理由)。
 */
export async function getManagedPrompt(
	definition: ManagedPromptDefinition,
	variables: Record<string, string>,
): Promise<ManagedPromptResult> {
	const lf = ensureClient();
	if (!lf) return fallbackResult(definition, variables, "code-no-keys");

	try {
		const prompt = await lf.prompt.get(definition.name, {
			label: resolvePromptLabel(),
			// 取得できなかったときは SDK がこれを包んだクライアントを返す。
			fallback: definition.template,
			// isolate が短命な Workers ではキャッシュがヒットしにくい。毎回1本 fetch が
			// 出る前提で、粘らずに早く諦める(fallback がコード側にあるので粘る価値がない)。
			//
			// **リトライしない**のが要点。地域Q&Aは同期経路で、この fetch は推論の前に
			// 直列で入る。しかも**失敗はキャッシュされない**（キャッシュに入るのは成功した
			// 取得だけ）ので、Langfuse が落ちている間は毎リクエストがこの待ちを払う。
			// 1回で諦めれば、上乗せの最悪値が `fetchTimeoutMs` 1回ぶんで頭打ちになる。
			cacheTtlSeconds: 60,
			maxRetries: 0,
			fetchTimeoutMs: 2_000,
		});
		if (prompt.isFallback) {
			// **ここは必ずログに出す。** Langfuse が落ちているときはトレースも届かないので、
			// `promptSource` は当てにできない —— 一番知りたい状況で唯一届く信号が
			// Workers Logs になる。
			logWarn("langfuse prompt fetch fell back to code", {
				op: "langfuse_prompt",
				prompt: definition.name,
				label: resolvePromptLabel(),
			});
			return fallbackResult(definition, variables, "code-fetch-failed");
		}

		const mismatch = checkTemplateVariables(prompt.prompt, {
			required: definition.variables,
			supplied: variables,
		});
		if (mismatch.missing.length > 0 || mismatch.unknown.length > 0) {
			logWarn("langfuse prompt variables do not match the code", {
				op: "langfuse_prompt",
				prompt: definition.name,
				version: prompt.version,
				missing: mismatch.missing,
				unknown: mismatch.unknown,
			});
			return fallbackResult(definition, variables, "code-invalid-template");
		}

		const text = prompt.compile(variables);
		if (hasUnresolvedPlaceholders(text)) {
			logWarn("langfuse prompt left unresolved placeholders", {
				op: "langfuse_prompt",
				prompt: definition.name,
				version: prompt.version,
			});
			return fallbackResult(definition, variables, "code-invalid-template");
		}

		return {
			text,
			ref: {
				name: definition.name,
				version: prompt.version,
				isFallback: false,
			},
			source: "langfuse",
		};
	} catch (e) {
		// `fallback` を渡しているので通常ここには来ないが、SDK の想定外(鍵の不正等)で
		// throw しうる。推論を止める理由にはしない。
		logWarn("langfuse prompt fetch failed", {
			op: "langfuse_prompt",
			prompt: definition.name,
			err: errToString(e),
		});
		return fallbackResult(definition, variables, "code-fetch-failed");
	}
}

/** テスト用。isolate 内 singleton を捨てる。 */
export function __resetLangfusePromptForTests(): void {
	client = null;
}
