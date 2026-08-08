import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import { creditLedger } from "#/db/schema";
import {
	AI_LABEL_GPT_MODEL,
	AI_LABEL_MODEL,
	AI_LABEL_WEB_MODEL,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_ROUTE_MODELS,
	estimateLabelReserveCharge,
} from "#/lib/ai/config";
import {
	type AiUsage,
	MICRO_USD_PER_CREDIT,
	usageToMicroUsd,
} from "#/lib/billing/ai-pricing";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";
import { costToCredits } from "#/lib/credit/credit-math";
import { REFUND_SUFFIX, SETTLE_SUFFIX } from "#/lib/credit/reservation";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import {
	answerRegionQuestion,
	isWineListAnalysisAvailable,
	resolveLabelPlan,
	resolveWineListPlan,
	runLabelAnalysisForJob,
	runWineListAnalysisForJob,
} from "./ai-service";
import { bulkRegisterFromScan, createDrunkWine } from "./drunk-wine-service";
import { beginMeteredInference } from "./metered-inference";

// ai-service のクレジット予約まわりを実D1で検証する。vitest.config.ts は AI バインディングを
// 用意しない(ローカルでもリモート接続を張るため)ので、env.AI はテスト内で差し替える。
// 見るのは推論の中身ではなく「予約 → 実測確定 / 失敗時返却」の骨格 —— つまり
// 推論が失敗したときにユーザのクレジットが焼き付いて消えないこと(#144/#158/#245)。

async function ledgerRowsOf(userId: string) {
	return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

async function balanceOf(userId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT balance FROM credit_balance WHERE user_id = ?",
	)
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "ai-user", `${id}@example.test`)
		.run();
	return id;
}

/**
 * プレミアム会員のユーザを作る。
 *
 * **高精度経路(Claude / GPT + web検索)の検証には要る**。コスト基準の計上では
 * Claude 経路の予約が写真2枚で約290クレジットになり、無料枠(150)では必ず
 * 残高不足でブロックされるため(#355)。無料会員が高精度経路を使えないこと自体は
 * 仕様どおりで、`残高不足(blocked)でも記録を残す` のテストがその側を押さえる。
 */
async function seedPremiumUser(): Promise<string> {
	const id = await seedUser();
	await db.insert(subscription).values({
		id: `sub-${id}`,
		plan: "premium",
		referenceId: id,
		status: "active",
	});
	return id;
}

/**
 * env.AI を差し替える。答えの中身ではなく「AI 呼び出しが成功/失敗したときに
 * 台帳と残高がどうなるか」を固定するためのスタブ。
 */
function stubAiRun(run: () => Promise<unknown>): void {
	(env as unknown as { AI: { run: () => Promise<unknown> } }).AI = { run };
}

/**
 * ANTHROPIC_API_KEY を差し替え、Anthropic API への outbound fetch をスタブする。
 * SDK はクライアント構築時に globalThis.fetch を掴むため、呼び出し前の stubGlobal で
 * 差し替われば実ネットワークには出ない。
 */
function stubAnthropic(respond: () => Promise<Response>): void {
	(env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY =
		"sk-ant-test";
	vi.stubGlobal("fetch", respond);
}

/** Anthropic Messages API の成功レスポンス(JSONテキスト + usage)を組み立てる。 */
function anthropicMessage(
	fields: Record<string, unknown>,
	usage: {
		input_tokens: number;
		output_tokens: number;
		server_tool_use?: { web_search_requests: number };
	},
): Response {
	return Response.json({
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "claude-opus-5",
		stop_reason: "end_turn",
		stop_sequence: null,
		content: [{ type: "text", text: JSON.stringify(fields) }],
		usage,
	});
}

/**
 * OPENAI_API_KEY を差し替え、OpenAI API への outbound fetch をスタブする。
 * stubAnthropic と同じ流儀(SDK が掴む globalThis.fetch を差し替える)。両方を
 * スタブしたい場合は stubProviders を使う。
 */
function stubOpenAi(respond: () => Promise<Response>): void {
	(env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
	vi.stubGlobal("fetch", respond);
}

/**
 * 両プロバイダのキーを立てた上で、リクエストURLで応答を振り分ける。
 * 「キーは両方あるが、走ってよいのは片方だけ」を検証するために要る
 * (vi.stubGlobal は後勝ちなので、stubAnthropic と stubOpenAi は併用できない)。
 */
function stubProviders(handlers: {
	openai: () => Promise<Response>;
	anthropic: () => Promise<Response>;
}): void {
	(env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
	(env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY =
		"sk-ant-test";
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		return url.includes("openai.com")
			? await handlers.openai()
			: await handlers.anthropic();
	});
}

/**
 * OpenAI Responses API の成功レスポンス(JSONテキスト + usage)を組み立てる。
 * SDK は output[].content[] の output_text ブロックから本文を組み立てるので、
 * message アイテムの形で返す必要がある。**一括抽出(生の Responses API 経路)用**。
 */
function openaiResponse(
	fields: Record<string, unknown>,
	usage: { input_tokens: number; output_tokens: number },
	webSearchCalls = 0,
): Response {
	return Response.json({
		id: "resp_test",
		object: "response",
		created_at: 0,
		model: "gpt-5.6-luna",
		status: "completed",
		error: null,
		incomplete_details: null,
		output: [
			// web検索の実行回数は usage に出ないので output から数える(回数課金)。
			...Array.from({ length: webSearchCalls }, (_, i) => ({
				type: "web_search_call",
				id: `ws_${i}`,
				status: "completed",
			})),
			{
				type: "message",
				id: "msg_test",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: JSON.stringify(fields),
						annotations: [],
					},
				],
			},
		],
		usage,
	});
}

/**
 * エチケット解析(エージェントループ経路)の成功レスポンス。
 *
 * **最終回答は本文テキストではなく `submit_answer` ツールの呼び出し**として返る。
 * 検証を通れば `stopWhen` がその場でループを止めるので、応答は1回で足りる
 * (2回目のリクエストは発生しない)。一括抽出は生の Responses API のままなので
 * `openaiResponse` と分けて持つ。
 */
function openaiSubmitAnswerResponse(
	fields: Record<string, unknown>,
	usage: { input_tokens: number; output_tokens: number },
	webSearchCalls = 0,
): Response {
	return Response.json({
		id: "resp_test",
		object: "response",
		created_at: 0,
		model: "gpt-5.6-luna",
		status: "completed",
		error: null,
		incomplete_details: null,
		output: [
			...Array.from({ length: webSearchCalls }, (_, i) => ({
				type: "web_search_call",
				id: `ws_${i}`,
				status: "completed",
			})),
			{
				type: "function_call",
				id: "fc_test",
				call_id: "call_test",
				name: "submit_answer",
				arguments: JSON.stringify(fields),
				status: "completed",
			},
		],
		usage,
	});
}

/**
 * `IMAGES` バインディングを差し替える。実変換はせず入力をそのまま返す
 * (テストの画像はダミーなので実際の変換は通らない)。**見たいのは変換結果ではなく、
 * ツールが渡り結果が画像として次のリクエストへ載ること**。
 */
function stubImages(): void {
	const passthrough = {
		transform: () => passthrough,
		output: async () => ({
			response: () => new Response(new Uint8Array([1, 2, 3])),
		}),
	};
	(env as unknown as { IMAGES: unknown }).IMAGES = {
		info: async () => ({
			format: "image/jpeg",
			fileSize: 3,
			width: 800,
			height: 1200,
		}),
		input: () => passthrough,
	};
}

/** OpenAI への outbound を捕まえつつ応答を返す(リクエスト本文を検査するため)。 */
function stubOpenAiCapturing(
	requests: string[],
	respond: () => Response,
): void {
	(env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		requests.push(typeof init?.body === "string" ? init.body : "");
		return respond();
	});
}

/** zoom_photo を1回呼ぶだけの応答。 */
function openaiZoomResponse(usage: {
	input_tokens: number;
	output_tokens: number;
}): Response {
	return Response.json({
		id: "resp_zoom",
		object: "response",
		created_at: 0,
		model: "gpt-5.6-luna",
		status: "completed",
		error: null,
		incomplete_details: null,
		output: [
			{
				type: "function_call",
				id: "fc_zoom",
				call_id: "call_zoom",
				name: "zoom_photo",
				arguments: JSON.stringify({
					photoIndex: 0,
					x: 0.3,
					y: 0.4,
					width: 0.2,
					height: 0.2,
				}),
				status: "completed",
			},
		],
		usage,
	});
}

afterEach(() => {
	delete (env as unknown as { AI?: unknown }).AI;
	delete (env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
	delete (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
	delete (env as unknown as { IMAGES?: unknown }).IMAGES;
	vi.unstubAllGlobals();
});

/** data URI 1枚ぶんのダミー(中身はスタブが解析しないので任意) */
const PHOTO = "data:image/jpeg;base64,AAAA";

/**
 * 実測 usage から確定後の残高を求める。**モデルごとの単価で換算する**(#355)ので、
 * 「同じトークン数でも経路によって消費クレジットが違う」ことがそのまま検証される。
 */
const balanceAfter = (
	model: string,
	usage: AiUsage,
	grant = MONTHLY_CREDITS_FREE,
) => grant - costToCredits(usageToMicroUsd(model, usage));

/**
 * Workers AI は usage の内訳を返さないため、実装は全量を出力単価で換算する(保守的)。
 * 期待値もその前提で作る。
 */
const balanceAfterWorkersAi = (model: string, totalTokens: number) =>
	balanceAfter(model, { outputTokens: totalTokens });

// 同期APIは #480 で削除した。これらのテストが見ているのは**共有の推論本体**
// (runLabelInference / runWineListInference)の挙動——経路の選択とフォールバック、
// 予約の確定と返却、実行記録——で、そこは同期経路が消えても変わらない。
// ジョブ経路の入口(予約 → 実行)を同期経路と同じ戻り値の形に畳んで、テストの本体は
// そのまま使う。**消してしまうと高精度経路の網が丸ごと無くなる**。

/** 予約 → エチケット解析1回。旧 `analyzeWineLabel` と同じ形を返す。 */
async function runLabelViaJob(
	userId: string,
	input: { imageDataUrls: string[] },
) {
	const plan = await resolveLabelPlan(userId, input.imageDataUrls.length);
	const begun = await beginMeteredInference(userId, {
		estimate: plan.estimate,
		requestId: plan.requestId,
		logBase: plan.logBase,
	});
	if (begun.blocked) {
		return {
			blocked: true as const,
			balance: begun.balance,
			required: begun.required,
		};
	}
	const done = await runLabelAnalysisForJob(userId, {
		imageDataUrls: input.imageDataUrls,
		plan,
		reservation: begun.reservation,
	});
	return {
		blocked: false as const,
		suggestions: done.value,
		actualTokens: done.charge.tokens,
		balance: done.balance,
	};
}

/** 予約 → 一括抽出1回。旧 `analyzeWineList` と同じ形を返す。 */
async function runWineListViaJob(
	userId: string,
	input: { imageDataUrls: string[] },
) {
	const plan = await resolveWineListPlan(userId, input.imageDataUrls.length);
	const begun = await beginMeteredInference(userId, {
		estimate: plan.estimate,
		requestId: plan.requestId,
		logBase: plan.logBase,
	});
	if (begun.blocked) {
		return {
			blocked: true as const,
			balance: begun.balance,
			required: begun.required,
		};
	}
	const done = await runWineListAnalysisForJob(userId, {
		imageDataUrls: input.imageDataUrls,
		plan,
		reservation: begun.reservation,
	});
	return {
		blocked: false as const,
		candidates: done.value.candidates,
		summary: done.value.summary,
		actualTokens: done.charge.tokens,
		balance: done.balance,
	};
}

describe("answerRegionQuestion のモデル解決順序 (#245)", () => {
	it("モデル解決の失敗で予約が無記録で消えない", async () => {
		// preferredAiModel の解決は userService.getCurrentUser 経由で D1 を読む。
		// ユーザ行が無ければ NotFoundError になり、D1 の一時エラーと同じ形で throw する。
		// この throw が予約の後・try の外で起きると、予約が返却も記録もされずに消える(#245)。
		const userId = "ai-service-missing-user";
		expect(
			await db.select().from(user).where(eq(user.id, userId)),
		).toHaveLength(0);

		await expect(
			answerRegionQuestion(userId, {
				regionId: "bourgogne",
				question: "シャブリの土壌は?",
			}),
		).rejects.toBeInstanceOf(NotFoundError);

		// 予約より前に落ちるので台帳には何も残らない。モデル解決が予約の後にあると、
		// ここに返却されないままの consume 行(と月次付与の grant 行)が残る。
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});
});

describe("answerRegionQuestion の予約 → 確定/返却", () => {
	const ask = (userId: string) =>
		answerRegionQuestion(userId, {
			regionId: "bourgogne",
			question: "シャブリの土壌は?",
		});

	it("推論が失敗したら予約を全額返却し、残高を元に戻す", async () => {
		const userId = await seedUser();
		const boom = new Error("AI unavailable");
		stubAiRun(() => Promise.reject(boom));

		// 推論失敗はそのまま呼び出し側へ伝える(返却が例外を握り潰さない #158)
		await expect(ask(userId)).rejects.toBe(boom);

		// 当月付与ぶんが丸ごと残っている = 予約が焼き付いていない
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);

		const rows = await ledgerRowsOf(userId);
		const consume = rows.find((r) => r.type === "consume");
		const refund = rows.find((r) => r.requestId?.endsWith(REFUND_SUFFIX));
		expect(consume).toBeDefined();
		expect(refund).toBeDefined();
		// 返却額は予約額と同額(=差し引きゼロ)。台帳にも痕跡が残る(#143)
		expect(refund?.amount).toBe(-(consume?.amount ?? 0));
		// 消費は確定していないので settle 台帳は無い
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("推論が成功したら実測ぶんだけ消費し、差分を戻す", async () => {
		const userId = await seedUser();
		const actualTokens = 42;
		stubAiRun(async () => ({
			response: "キンメリジャンの石灰質土壌です。",
			usage: { total_tokens: actualTokens },
		}));

		const result = await ask(userId);

		expect(result).toMatchObject({
			blocked: false,
			answer: "キンメリジャンの石灰質土壌です。",
			actualTokens,
		});
		// 見積との差分は戻るので、最終的な消費は実測ぶんだけ
		const expected = balanceAfterWorkersAi(
			AI_REGION_QA_MODELS.gemma4.id,
			actualTokens,
		);
		expect(await balanceOf(userId)).toBe(expected);
		expect((result as { balance: number }).balance).toBe(expected);

		const rows = await ledgerRowsOf(userId);
		// 確定は settle 接尾辞の台帳で表す(返却済みかどうかの判別に使う #146)
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
	});

	it("実測が取れないモデルでも予約全量を消費として確定する(返却0=安全側)", async () => {
		const userId = await seedUser();
		// usage を返さないモデル。ここで「実測0」と扱うと予約全額が戻り、消費が無料になる
		stubAiRun(async () => ({ response: "回答" }));

		const result = await ask(userId);

		expect(result).toMatchObject({ blocked: false });
		expect(await balanceOf(userId)).toBeLessThan(MONTHLY_CREDITS_FREE);
	});
});

describe("エチケット解析の予約 → 返却", () => {
	it("全ての写真の解析に失敗したら予約を全額返却する", async () => {
		const userId = await seedUser();
		stubAiRun(() => Promise.reject(new Error("model error")));

		// 個々の写真の失敗はスキップされるが、全滅なら推論失敗として throw する
		await expect(
			runLabelViaJob(userId, { imageDataUrls: [PHOTO, PHOTO] }),
		).rejects.toThrow("すべての写真の解析に失敗しました");

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("ANTHROPIC_API_KEY 設定時はClaude経路で解析し、usage合算で確定する", async () => {
		const userId = await seedPremiumUser();
		stubAnthropic(async () =>
			anthropicMessage(
				{
					wine_name: "Chablis Les Clos",
					producer: "Vincent Dauvissat",
					vintage: 2020,
					appellation: "Chablis Grand Cru",
					region: "Bourgogne",
					grape_varieties: ["Chardonnay"],
				},
				{ input_tokens: 1000, output_tokens: 200 },
			),
		);
		// Claude経路が成功する限り Workers AI には触れない(触れたら失敗として検出される)
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runLabelViaJob(userId, {
			imageDataUrls: [PHOTO, PHOTO],
		});

		expect(result).toMatchObject({ blocked: false, actualTokens: 1200 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.suggestions).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
			vintage: 2020,
			// AOPが解決できたら地域は候補に含めない(産地は最も細かい1つだけ)
			aopId: "chablis-grand-cru",
			grapeVarietyIds: ["chardonnay"],
		});
		// 実測ぶんだけ消費し、予約との差分は返る。**Opus の単価で換算される**ので、
		// 同じ 1,200 トークンでも Workers AI 経路より2桁多く消費する。
		expect(await balanceOf(userId)).toBe(
			balanceAfter(
				AI_LABEL_WEB_MODEL,
				{
					inputTokens: 1000,
					outputTokens: 200,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					webSearches: 0,
				},
				MONTHLY_CREDITS_PREMIUM,
			),
		);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
	});

	it("ユーザが標準(workers-ai)を選択していればキー設定時でもClaude経路を使わない", async () => {
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'workers-ai' WHERE id = ?",
		)
			.bind(userId)
			.run();
		// Claude経路に入ってしまった場合はこちらの usage(9999)で確定してしまうため、
		// 最終的な actualTokens が Workers AI の実測(60)であることが経路選択の証明になる
		// (fetch を失敗させる方式だとフォールバックと区別が付かない)
		stubAnthropic(async () =>
			anthropicMessage(
				{ wine_name: "wrong path" },
				{ input_tokens: 9000, output_tokens: 999 },
			),
		);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: null,
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 60 },
		}));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		// Workers AI 経路の実測(60)で確定 = Claude経路のトークンが混ざっていない
		expect(result).toMatchObject({ blocked: false, actualTokens: 60 });
	});

	it("Claude経路が失敗したら Workers AI へフォールバックして完了する", async () => {
		const userId = await seedPremiumUser();
		// 400 はSDKがリトライしない失敗。経路ごと諦めてフォールバックさせる
		stubAnthropic(async () =>
			Response.json(
				{
					type: "error",
					error: { type: "invalid_request_error", message: "bad request" },
				},
				{ status: 400 },
			),
		);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: "Chablis",
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 55 },
		}));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 55 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.suggestions.name).toBe("Chablis");
		// フォールバック後も settle で確定し、予約が焼き付かない。**実際に結果を出した
		// Workers AI の単価で課金する**(Opus の単価で Llama の推論を課金しない)。
		expect(await balanceOf(userId)).toBe(
			balanceAfter(
				AI_LABEL_MODEL,
				{ outputTokens: 55 },
				MONTHLY_CREDITS_PREMIUM,
			),
		);
	});

	// Issue #404: 実測が取れないときのフォールバックは「予約全量を実測とみなす」形
	// だったが、**予約は意図した経路(Claude ≈275クレジット)の見積**。Workers AI が
	// 拾った回にそれを課金すると、Llama 1回の推論に275クレジットを確定課金してしまう。
	// Workers AI の usage は任意(返らないことがある)ので、経路の複合で実際に起きうる。
	it("Claude経路の失敗をWorkers AIが拾い実測が取れなくても、課金はWorkers AIの見積で止まる", async () => {
		const userId = await seedPremiumUser();
		stubAnthropic(async () =>
			Response.json(
				{
					type: "error",
					error: { type: "invalid_request_error", message: "bad request" },
				},
				{ status: 400 },
			),
		);
		// usage を返さない Workers AI 応答(実測 0 → フォールバック経路に入る)
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: null,
				region: null,
				grape_varieties: [],
			}),
		}));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false });
		const workersAi = costToCredits(
			estimateLabelReserveCharge("workers-ai", 1).microUsd,
		);
		const webResearch = costToCredits(
			estimateLabelReserveCharge("web-research", 1).microUsd,
		);
		// 予約額(高精度経路の見積)との差が大きいことを明示しておく。ここが縮むと
		// このテストは「たまたま同じ値」で通ってしまい、回帰を検出できなくなる。
		expect(webResearch).toBeGreaterThan(workersAi * 10);
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_PREMIUM - workersAi);
	});

	// #404 の修正で「実測が取れないときは常に安い方」に倒しすぎていないことの裏側。
	// 降格せず高精度経路が結果を出したなら、床は今まで通りその経路の見積(=予約額)。
	it("Claude経路が結果を出したなら、実測が取れなくても床はClaude経路の見積のまま", async () => {
		const userId = await seedPremiumUser();
		stubAnthropic(async () =>
			anthropicMessage(
				{ wine_name: "Chablis" },
				{ input_tokens: 0, output_tokens: 0 },
			),
		);

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false });
		expect(await balanceOf(userId)).toBe(
			MONTHLY_CREDITS_PREMIUM -
				costToCredits(estimateLabelReserveCharge("web-research", 1).microUsd),
		);
	});

	// 入力検証(空・枚数超過)は #480 で投入(`submitLabelAnalysisJob`)の責務になった。
	// 「予約せずに弾く」の回帰は label-job-service.workers.test.ts が見ている。
});

// GPT-5.6 Luna 経路。既定エンジンなので「キーがあれば黙って走る」ことと、
// 「キーが無いときに何へ降格するか」の両方を固定する。
describe("エチケット解析のGPT-5.6 Luna経路", () => {
	it("OPENAI_API_KEY 設定時はGPT経路で解析し、usage内訳とweb検索回数で確定する", async () => {
		const userId = await seedPremiumUser();
		stubOpenAi(async () =>
			openaiSubmitAnswerResponse(
				{
					wine_name: "Chablis Les Clos",
					producer: "Vincent Dauvissat",
					vintage: 2020,
					appellation: "Chablis Grand Cru",
					region: "Bourgogne",
					grape_varieties: ["Chardonnay"],
				},
				{ input_tokens: 1300, output_tokens: 200 },
				3,
			),
		);
		// GPT経路が成功する限り Workers AI には触れない(触れたら失敗として検出される)
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runLabelViaJob(userId, {
			imageDataUrls: [PHOTO, PHOTO],
		});

		expect(result).toMatchObject({ blocked: false, actualTokens: 1500 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.suggestions).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
			vintage: 2020,
			// AOPが解決できたら地域は候補に含めない(産地は最も細かい1つだけ)
			aopId: "chablis-grand-cru",
			grapeVarietyIds: ["chardonnay"],
		});
		// 実測ぶんだけ消費し、予約との差分は返る。**web検索3回ぶんの回数課金も乗る**
		// (転換前はここが完全に計上漏れだった)。
		expect(await balanceOf(userId)).toBe(
			balanceAfter(
				AI_LABEL_GPT_MODEL,
				{
					inputTokens: 1300,
					outputTokens: 200,
					cacheReadTokens: 0,
					webSearches: 3,
				},
				MONTHLY_CREDITS_PREMIUM,
			),
		);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
	});

	it("GPT経路が失敗したら Workers AI へフォールバックして完了する", async () => {
		const userId = await seedPremiumUser();
		// 400 はSDKがリトライしない失敗。経路ごと諦めてフォールバックさせる
		stubOpenAi(async () =>
			Response.json(
				{ error: { type: "invalid_request_error", message: "bad request" } },
				{ status: 400 },
			),
		);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: "Chablis",
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 55 },
		}));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 55 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.suggestions.name).toBe("Chablis");
		// 実際に結果を出した Workers AI の単価で課金する(Luna の単価にしない)。
		expect(await balanceOf(userId)).toBe(
			balanceAfter(
				AI_LABEL_MODEL,
				{ outputTokens: 55 },
				MONTHLY_CREDITS_PREMIUM,
			),
		);
	});

	it("途中で打ち切られた応答(incomplete)は成功扱いせずフォールバックする", async () => {
		const userId = await seedPremiumUser();
		// web検索と reasoning が出力枠を使い切ると、JSONが途中で切れたまま 200 で返る。
		// これを成功として扱うと「形式が不正」という無関係な例外で解析全体が落ちる。
		stubOpenAi(async () =>
			Response.json({
				id: "resp_test",
				object: "response",
				created_at: 0,
				model: "gpt-5.6-luna",
				status: "incomplete",
				error: null,
				incomplete_details: { reason: "max_output_tokens" },
				output: [],
				usage: { total_tokens: 16000 },
			}),
		);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: "Chablis",
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 55 },
		}));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 55 });
	});

	it("OPENAI_API_KEY 未設定なら、既定のままでも Claude経路へ引き継ぐ", async () => {
		// 既定を gpt-luna に変えたことで、ANTHROPIC_API_KEY だけ設定された環境
		// (#354 時点の本番)が黙って Workers AI へ降格しないことの回帰テスト。
		const userId = await seedPremiumUser();
		stubAnthropic(async () =>
			anthropicMessage(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: "Chablis",
					region: null,
					grape_varieties: [],
				},
				{ input_tokens: 800, output_tokens: 100 },
			),
		);
		// Workers AI へ落ちたらここで失敗する
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 900 });
	});

	it("両キー設定時にユーザがClaudeを選んでいればGPT経路を使わない", async () => {
		const userId = await seedPremiumUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		// 経路の証明は実測トークン: GPT経路に入ってしまえば 9999 で確定する
		stubProviders({
			openai: async () =>
				openaiSubmitAnswerResponse(
					{ wine_name: "wrong path" },
					{ input_tokens: 9999, output_tokens: 0 },
				),
			anthropic: async () =>
				anthropicMessage(
					{
						wine_name: "Chablis",
						producer: null,
						vintage: null,
						appellation: "Chablis",
						region: null,
						grape_varieties: [],
					},
					{ input_tokens: 700, output_tokens: 70 },
				),
		});
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 770 });
	});

	it("両キー設定時の既定(未選択)ではGPT経路を使う", async () => {
		const userId = await seedPremiumUser();
		stubProviders({
			openai: async () =>
				openaiSubmitAnswerResponse(
					{
						wine_name: "Chablis",
						producer: null,
						vintage: null,
						appellation: "Chablis",
						region: null,
						grape_varieties: [],
					},
					{ input_tokens: 1234, output_tokens: 0 },
				),
			anthropic: async () =>
				anthropicMessage(
					{ wine_name: "wrong path" },
					{ input_tokens: 9000, output_tokens: 999 },
				),
		});
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 1234 });
	});

	it("画像変換が使えるときは zoom_photo を渡し、切り出した画像がモデルへ届く", async () => {
		// **この経路の精度を決める往復**。ボトル全体の写真ではラベルの文字が潰れて読めず、
		// 実測では原寸を送っても改善しなかった。効いたのは切り出しだけなので、
		// 「ツールが渡り、結果が画像として次のリクエストに載る」ことを固定する。
		const userId = await seedPremiumUser();
		stubImages();
		const requests: string[] = [];
		let call = 0;
		stubOpenAiCapturing(requests, () => {
			call += 1;
			// 1回目: 拡大を要求する。2回目: 提出する。
			return call === 1
				? openaiZoomResponse({ input_tokens: 1000, output_tokens: 100 })
				: openaiSubmitAnswerResponse(
						{
							wine_name: "Chablis Les Clos",
							producer: "Vincent Dauvissat",
							vintage: 2020,
							appellation: "Chablis Grand Cru",
							region: "Bourgogne",
							grape_varieties: ["Chardonnay"],
						},
						{ input_tokens: 1300, output_tokens: 200 },
					);
		});
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false });
		// 1回目のリクエストに zoom_photo がツールとして載る
		expect(requests[0]).toContain("zoom_photo");
		// 2回目のリクエストには切り出した画像が input_image として載る
		// (JSONで座標だけ返しても読めるようにはならない)
		expect(requests[1]).toContain("input_image");
	});
});

// 複数写真からのワイン一括抽出(Issue #358)。Claude 専用・フォールバック無しの経路なので、
// 見るのは「予約 → 実測確定 / 失敗時返却」に加えて、**失敗の種類ごとにクレジットが
// どう扱われるか**(キー未設定は予約前に拒否、出力の打ち切りは返却)。
describe("一括抽出の予約 → 確定/返却", () => {
	/** モデルが返す銘柄1件のJSON(省略項目は null / 空配列)。 */
	function wineJson(partial: Record<string, unknown>): Record<string, unknown> {
		return {
			wine_name: null,
			producer: null,
			vintage: null,
			appellation: null,
			region: null,
			grape_varieties: [],
			price: null,
			photo_indexes: [],
			...partial,
		};
	}

	it("解析に成功したら候補とサマリを返し、実測ぶんだけ消費する", async () => {
		// **プレミアムで回す**。写真をまたいだ重複統合を見るので2枚必要だが、裏取りが
		// 乗った Claude 経路(#474)の2枚は無料付与(200)を超えて blocked になる。
		// 無料枠に収まるかどうかは wine-list-extraction.test.ts の不変条件が見ている。
		const userId = await seedPremiumUser();
		stubAnthropic(async () =>
			anthropicMessage(
				{
					wines: [
						wineJson({
							wine_name: "Chablis Les Clos",
							producer: "Vincent Dauvissat",
							vintage: 2020,
							appellation: "Chablis Grand Cru",
							price: 24000,
							photo_indexes: [0],
						}),
						// 写真をまたいだ重複。モデルの統合漏れをアプリ側で畳む
						wineJson({
							wine_name: "chablis les clos",
							producer: "vincent dauvissat",
							vintage: 2020,
							photo_indexes: [1],
						}),
					],
					truncated: false,
				},
				{ input_tokens: 3000, output_tokens: 500 },
			),
		);

		const result = await runWineListViaJob(userId, {
			imageDataUrls: [PHOTO, PHOTO],
		});

		expect(result).toMatchObject({ blocked: false, actualTokens: 3500 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.summary).toEqual({
			detected: 1,
			subject: "wine_list",
			mergedDuplicates: 1,
			matchedExisting: 0,
			truncated: false,
		});
		expect(result.candidates[0]).toMatchObject({
			price: 24000,
			photoIndexes: [0, 1],
		});
		expect(result.candidates[0]?.suggestions).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
			vintage: 2020,
			// AOPが解決できたら地域は候補に含めない(産地は最も細かい1つだけ)
			aopId: "chablis-grand-cru",
		});
		expect(await balanceOf(userId)).toBe(
			balanceAfter(
				AI_WINE_LIST_ROUTE_MODELS["web-research"],
				{
					inputTokens: 3000,
					outputTokens: 500,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					// スタブの応答に server_tool_use が無い = このケースは検索0回。
					// 実測どおり計上されることは usage-accounting.test.ts が見ている。
					webSearches: 0,
				},
				MONTHLY_CREDITS_PREMIUM,
			),
		);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
	});

	it("OPENAI_API_KEY だけの環境では GPT 経路で解析し、Luna の単価で確定する", async () => {
		const userId = await seedUser();
		stubOpenAi(async () =>
			openaiResponse(
				{
					wines: [
						wineJson({
							wine_name: "Chablis Les Clos",
							producer: "Vincent Dauvissat",
							vintage: 2020,
							photo_indexes: [0],
						}),
					],
					subject: "wine_list",
					truncated: false,
				},
				{ input_tokens: 3000, output_tokens: 500 },
			),
		);
		// 一括抽出は Workers AI へ降格しない(触れたら失敗として検出される)
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 3500 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.candidates[0]?.suggestions).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
		});
		// **Luna の単価で計上されること**がこの経路を入れた主目的(#426)。
		// Claude の単価で確定していたらここで落ちる。
		expect(await balanceOf(userId)).toBe(
			balanceAfter(AI_WINE_LIST_ROUTE_MODELS["gpt-luna"], {
				inputTokens: 3000,
				outputTokens: 500,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				webSearches: 0,
			}),
		);
	});

	it("両キーがあれば既定(gpt-luna)で GPT が走り、Claude は呼ばない", async () => {
		const userId = await seedUser();
		// 経路の証明は実測トークン: Claude 経路に入ってしまえば 9999 で確定する
		stubProviders({
			openai: async () =>
				openaiResponse(
					{ wines: [wineJson({ wine_name: "Chablis" })], truncated: false },
					{ input_tokens: 100, output_tokens: 20 },
				),
			anthropic: async () =>
				anthropicMessage(
					{ wines: [wineJson({ wine_name: "wrong path" })] },
					{ input_tokens: 9999, output_tokens: 0 },
				),
		});

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 120 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.candidates[0]?.suggestions.name).toBe("Chablis");
	});

	it("標準(Workers AI)を選んでいても一括抽出は高精度経路で走る", async () => {
		// エチケット解析は「標準」で Workers AI に落ちるが、一括抽出は降格しない
		// (#358)。ここが落ちると、標準を選んだユーザだけ一括登録が使えなくなる。
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'workers-ai' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenAi(async () =>
			openaiResponse(
				{ wines: [wineJson({ wine_name: "Chablis" })], truncated: false },
				{ input_tokens: 100, output_tokens: 20 },
			),
		);
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 120 });
	});

	it("GPT の応答が出力上限で切れたら予約を全額返却し、写真を分ける案内を返す", async () => {
		// Claude の stop_reason="max_tokens" と同じ扱いに揃える(#426)。
		// structured outputs でも incomplete は起きるので、パースに回すと
		// 「形式が不正」という無関係な例外になる。
		const userId = await seedUser();
		stubOpenAi(async () =>
			Response.json({
				id: "resp_test",
				object: "response",
				created_at: 0,
				model: "gpt-5.6-luna",
				status: "incomplete",
				error: null,
				incomplete_details: { reason: "max_output_tokens" },
				output: [],
				usage: { input_tokens: 5000, output_tokens: 20000 },
			}),
		);

		await expect(
			runWineListViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toBeInstanceOf(BadRequestError);

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("既存セラーに同じ銘柄があれば新規作成ではなく目撃追加の候補にする", async () => {
		const userId = await seedUser();
		const existing = await createDrunkWine(userId, {
			name: "Chablis",
			producer: "Domaine Testut",
			vintage: 2020,
			status: "finished",
		});
		stubAnthropic(async () =>
			anthropicMessage(
				{
					wines: [
						wineJson({
							wine_name: "Chablis",
							producer: "Domaine Testut",
							vintage: 2020,
						}),
						wineJson({ wine_name: "Sancerre", producer: "Domaine Vacheron" }),
					],
				},
				{ input_tokens: 1000, output_tokens: 200 },
			),
		);

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		if (result.blocked) throw new Error("unreachable");
		expect(result.summary.matchedExisting).toBe(1);
		expect(result.candidates[0]?.existing).toMatchObject({
			id: existing.id,
			name: "Chablis",
			vintage: 2020,
			status: "finished",
		});
		// 既存に無い銘柄は新規作成の候補のまま
		expect(result.candidates[1]?.existing).toBeUndefined();
	});

	it("一括登録で作ったエントリを再解析すると、新規ではなく既存への追加になる", async () => {
		// 履歴からの再解析(#427)が成立する前提そのもの。ここが崩れると、同じ写真を
		// 解析し直すたびに同じ銘柄が二重に作られる。**bulkRegisterFromScan で作った
		// エントリ**で確かめるのが要点(createDrunkWine 経由の一致は別テストが見ている)。
		const userId = await seedUser();
		const wines = [
			{
				wine_name: "Chablis 1er Cru Montée de Tonnerre",
				producer: "William Fèvre",
				vintage: 2021,
				photo_indexes: [0],
			},
			{
				wine_name: 'Barolo "Bussia"',
				producer: "Prunotto",
				vintage: 2018,
				photo_indexes: [0],
			},
		];
		await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: wines.map((w) => ({
				wine: {
					name: w.wine_name,
					producer: w.producer,
					vintage: w.vintage,
				},
				sighting: { photoIndex: 0 },
			})),
		});
		stubAnthropic(async () =>
			anthropicMessage(
				{ wines: wines.map(wineJson), truncated: false },
				{ input_tokens: 1000, output_tokens: 200 },
			),
		);

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		if (result.blocked) throw new Error("unreachable");
		expect(result.summary.matchedExisting).toBe(2);
		expect(result.candidates.every((c) => !!c.existing)).toBe(true);
	});

	it("出力が上限で打ち切られたら予約を全額返却し、写真を分ける案内を返す", async () => {
		const userId = await seedUser();
		// max_tokens で切れた応答は JSON が途中で終わっている。成功扱いすると
		// 「形式が不正」という無関係な例外になり、ユーザは次の行動を選べない
		stubAnthropic(async () =>
			Response.json({
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-opus-5",
				stop_reason: "max_tokens",
				stop_sequence: null,
				content: [{ type: "text", text: '{"wines":[{"wine_name":"Chab' }],
				usage: { input_tokens: 5000, output_tokens: 32000 },
			}),
		);

		await expect(
			runWineListViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toBeInstanceOf(BadRequestError);

		// 解析結果を受け取れていないので課金しない(予約は全額返却)
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("Claude 呼び出しが失敗したら予約を全額返却する(フォールバックしない)", async () => {
		const userId = await seedUser();
		stubAnthropic(async () =>
			Response.json(
				{
					type: "error",
					error: { type: "invalid_request_error", message: "bad request" },
				},
				{ status: 400 },
			),
		);
		// エチケット解析と違い Workers AI への降格は無い(触れたら失敗として検出される)
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));

		await expect(
			runWineListViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toThrow();

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
	});

	it("両プロバイダのキーが未設定なら予約せずに 503 で拒否する", async () => {
		// 一括抽出は Workers AI へ降格しない(#358)ので、高精度経路が1つも無ければ
		// 機能ごと使えない。afterEach で両キーとも消えている状態を使う。
		const userId = await seedUser();
		expect(isWineListAnalysisAvailable()).toBe(false);

		await expect(
			runWineListViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toMatchObject({ status: 503 });

		// 予約前に落ちるので台帳は空(月次付与すら走らない)
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});

	// 入力検証(空・枚数超過)は #480 で投入(`submitLabelAnalysisJob`)の責務になった。
	// 「予約せずに弾く」の回帰は label-job-service.workers.test.ts が見ている。
});

// 実行記録(#357 の振り返り)。GPT-5.6 Luna 導入時の本番確認では成功ログが無く、
// 「警告が出ていない」という失敗の不在からしか成否を判断できなかった。
// ここでは「成功時に1行出ること」と「フォールバックが成功ログ上で判別できること」を固定する。
describe("エチケット解析の実行記録ログ", () => {
	/** console.info の JSON 行から ai inference の実行記録だけを拾う。 */
	function captureInferenceLogs(spy: {
		mock: { calls: unknown[][] };
	}): Array<Record<string, unknown>> {
		const lines: Array<Record<string, unknown>> = [];
		for (const call of spy.mock.calls) {
			try {
				const parsed = JSON.parse(String(call[0])) as Record<string, unknown>;
				if (parsed.msg === "ai inference") lines.push(parsed);
			} catch {
				// 実行記録以外の出力(素の console.info)は無視する
			}
		}
		return lines;
	}

	it("GPT経路の成功を1行残す(誰が・どのモデルで・成功したか)", async () => {
		const userId = await seedUser();
		stubOpenAi(async () =>
			openaiSubmitAnswerResponse(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: "Chablis",
					region: null,
					grape_varieties: [],
				},
				{ input_tokens: 1234, output_tokens: 0 },
			),
		);
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});

		try {
			await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });
			const logs = captureInferenceLogs(spy);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				feature: "label_analysis",
				userId,
				outcome: "ok",
				route: "gpt-luna",
				executedBy: "gpt-luna",
				model: "gpt-5.6-luna",
				fellBack: false,
				actualTokens: 1234,
				photoCount: 1,
			});
			// 台帳と突き合わせられるよう request_id が載る
			expect(String(logs[0]?.requestId)).toMatch(/^analyze_label:/);
		} finally {
			spy.mockRestore();
		}
	});

	it("フォールバックは成功ログ上で route と executedBy の食い違いとして見える", async () => {
		const userId = await seedUser();
		// GPT を 400 で落とし、Workers AI に拾わせる
		stubOpenAi(async () =>
			Response.json({ error: { message: "bad request" } }, { status: 400 }),
		);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: "Chablis",
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 55 },
		}));
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});

		try {
			await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });
			const logs = captureInferenceLogs(spy);
			expect(logs).toHaveLength(1);
			// route(意図)は gpt-luna のまま、executedBy(実際)が workers-ai になる。
			// executedBy を持たない実装だと、この2つが同じに見えて成功ログから
			// フォールバックを検出できない。
			expect(logs[0]).toMatchObject({
				outcome: "ok",
				route: "gpt-luna",
				executedBy: "workers-ai",
				model: "@cf/meta/llama-4-scout-17b-16e-instruct",
				fellBack: true,
				actualTokens: 55,
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("残高不足(blocked)でも記録を残す(推論しなかったことが分かる)", async () => {
		const userId = await seedUser();
		// 残高を直接0にしても reserveCredits 冒頭の月次付与で上書きされるため、
		// **見積が月次付与を超える経路**を選ばせて予約を弾かせる。
		// Claude経路は写真1枚でも約275クレジットで、無料会員の月次付与(150)を超える
		// ——コスト基準では高精度経路が無料枠では使えないのが仕様(#355)。
		// 前提が崩れたら(単価改定・付与増で足りるようになったら)ここで気付けるよう、
		// magic number ではなく見積関数と付与額から導いて確認する。
		expect(
			estimateLabelReserveCharge("web-research", 1).microUsd,
		).toBeGreaterThan(MONTHLY_CREDITS_FREE * MICRO_USD_PER_CREDIT);
		const photos = [PHOTO];
		stubAnthropic(async () =>
			anthropicMessage({}, { input_tokens: 1, output_tokens: 0 }),
		);
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});

		try {
			const result = await runLabelViaJob(userId, { imageDataUrls: photos });
			expect(result.blocked).toBe(true);
			const logs = captureInferenceLogs(spy);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				feature: "label_analysis",
				outcome: "blocked",
				route: "web-research",
				photoCount: photos.length,
			});
			// 推論に到達していないので実行経路は載らない
			expect(logs[0]).not.toHaveProperty("executedBy");
		} finally {
			spy.mockRestore();
		}
	});
});
