/**
 * コードの `MANAGED_PROMPTS` を Langfuse へ**初期登録**し、以後は差分を報告するだけの
 * スクリプト(#512 Phase 4)。
 *
 * このリポジトリでは**プロンプト本文のSSOTは Langfuse 側**にある。だからここは
 * 「コードの内容で上書きする」道具ではない:
 *
 *   - 未登録 → `production` / `preview` ラベル付きで種を蒔く(コード → Langfuse の
 *     書き込みはこの1回だけ)
 *   - 登録済み → 本文を比べて差分を表示するだけ。**上書きしない**
 *
 * 差分は異常ではない。Langfuse 側で改善した版が育っている、という意味なので、
 * 「コードの fallback が現行の本番プロンプトからどれだけ離れたか」を測る道具として使う。
 * 離れすぎたら fallback をコードへ取り込み直す(取り込みは手で書く)。
 *
 * 使い方:
 *   bun run sync:prompts             # 未登録があれば登録する
 *   bun run sync:prompts --dry-run   # 何も書き込まず、やることだけ表示する
 *   bun run sync:prompts --check     # 差分・未登録があれば非ゼロ終了(書き込まない)
 *
 * 鍵は環境変数か `.dev.vars` から読む。**CI からは実行しない** —— Langfuse の鍵を
 * GitHub Actions へ置かない方針(Sentry / Stripe と同じく、鍵の投入は手作業)。
 *
 * agentプロキシ下の環境(Claude Code on the web 等)で `bun --version` が **1.3.13 以下**なら、
 * このスクリプトは Node で実行する:
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/sync-langfuse-prompts.ts
 *
 * 1.3.13 以下の bun は `fetch` の ClientHello に ECH GREASE を付け、プロキシのTLS終端が
 * それを落とすため TLS ハンドシェイクで ECONNRESET になる(**HTTPS_PROXY 非対応が原因では
 * ない**。bun は HTTPS_PROXY を読んでおり CONNECT は 200 まで進む)。v1.3.14 で修正済み。
 *
 * **`packageManager` の版で判断しない。** 実行コンテナに入っている bun はイメージ側の版で
 * `packageManager` に追従しないため、両者は食い違う。詳細は `verify` skill。
 */

import { readFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import {
	extractTemplateVariables,
	MANAGED_PROMPTS,
	type ManagedPromptDefinition,
} from "#/lib/ai/managed-prompts";

const BASE_URL = "https://jp.cloud.langfuse.com";
const LABELS = ["production", "preview"] as const;

/** `.dev.vars`(dotenv 形式)から鍵を補う。環境変数が優先。 */
function readKey(name: string): string {
	const fromEnv = process.env[name]?.trim();
	if (fromEnv) return fromEnv;
	let text: string;
	try {
		text = readFileSync(".dev.vars", "utf8");
	} catch {
		return "";
	}
	for (const line of text.split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!m || m[1] !== name) continue;
		return (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
	}
	return "";
}

/**
 * 登録済みの本文を引く。**未登録(404)だけを `null` にする。**
 *
 * ここで通信エラーまで `null` に畳むと「未登録」と区別が付かず、一時的な失敗の回に
 * `create` が走って既存プロンプトへ重複バージョンを積む。判断材料が取れなかったときは
 * 黙って進めずに throw して、呼び出し側で止める。
 */
async function fetchText(
	client: LangfuseClient,
	name: string,
	label: string,
): Promise<{ text: string; version: number } | null> {
	try {
		const prompt = await client.prompt.get(name, {
			label,
			// 同期の判断材料なのでキャッシュを挟まない。
			cacheTtlSeconds: 0,
			maxRetries: 0,
		});
		return { text: prompt.prompt, version: prompt.version };
	} catch (e) {
		if (isNotFound(e)) return null;
		throw new Error(`${name} (label=${label}) の取得に失敗しました`, {
			cause: e,
		});
	}
}

/** Langfuse の 404(その名前/ラベルの版が無い)か。それ以外は取得失敗として扱う。 */
function isNotFound(e: unknown): boolean {
	const status = (e as { statusCode?: unknown } | null)?.statusCode;
	return status === 404;
}

/** コード側の定義が自己矛盾していないか(宣言した変数がテンプレートに全部あるか)。 */
function assertDefinitionConsistent(definition: ManagedPromptDefinition): void {
	const present = new Set(extractTemplateVariables(definition.template));
	const missing = definition.variables.filter((v) => !present.has(v));
	if (missing.length > 0) {
		throw new Error(
			`${definition.name}: template に変数がありません: ${missing.join(", ")}`,
		);
	}
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	const checkOnly = process.argv.includes("--check");

	const publicKey = readKey("LANGFUSE_PUBLIC_KEY");
	const secretKey = readKey("LANGFUSE_SECRET_KEY");
	if (!publicKey || !secretKey) {
		console.error(
			"LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY が見つかりません(環境変数か .dev.vars に入れてください)",
		);
		process.exit(1);
	}
	const client = new LangfuseClient({
		publicKey,
		secretKey,
		baseUrl: BASE_URL,
	});

	let drifted = 0;
	let seeded = 0;
	for (const definition of MANAGED_PROMPTS) {
		assertDefinitionConsistent(definition);
		const current = await fetchText(client, definition.name, "production");

		if (!current) {
			console.log(`[未登録] ${definition.name}`);
			if (dryRun || checkOnly) {
				console.log(`  → ${LABELS.join(" / ")} ラベル付きで登録します`);
				drifted += 1;
				continue;
			}
			await client.prompt.create({
				name: definition.name,
				type: "text",
				prompt: definition.template,
				labels: [...LABELS],
				commitMessage: "seed from MANAGED_PROMPTS",
			});
			console.log(`  → v1 を登録しました(${LABELS.join(" / ")})`);
			seeded += 1;
			continue;
		}

		if (current.text === definition.template) {
			console.log(`[一致] ${definition.name} (production v${current.version})`);
		} else {
			console.log(
				`[差分] ${definition.name} (production v${current.version}) — Langfuse 側が進んでいます`,
			);
			console.log(
				`  コードの fallback: ${definition.template.length} 文字 / Langfuse: ${current.text.length} 文字`,
			);
			drifted += 1;
		}

		const preview = await fetchText(client, definition.name, "preview");
		if (!preview) {
			console.log(
				"  ! preview ラベルの版がありません(プレビュー/ローカルは fallback で動きます)",
			);
		}
	}

	if (seeded > 0) console.log(`\n${seeded} 件を登録しました。`);
	if (checkOnly && drifted > 0) {
		console.error(`\n${drifted} 件に差分/未登録があります。`);
		process.exit(1);
	}
}

await main();
