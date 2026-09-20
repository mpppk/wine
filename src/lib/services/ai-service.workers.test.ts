import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import { creditLedger } from "#/db/schema";
import {
	AI_LABEL_GPT_MODEL,
	AI_LABEL_WEB_MODEL,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_GPT_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_ROUTE_MODELS,
	estimateLabelReserveCharge,
	estimateWineListReserveCharge,
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
import { OpenRouterError } from "#/lib/ai/openrouter";
import {
	answerRegionQuestion,
	isWineListAnalysisAvailable,
	resolveLabelPlan,
	resolveWineListPlan,
	restoreLabelPlan,
	restoreWineListPlan,
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
 * OPENROUTER_API_KEY を立て、OpenRouter への outbound fetch をスタブする。
 * **接続先は OpenRouter だけ**(直接接続の残存はここで throw して検出する)。
 */
function stubOpenRouter(respond: () => Promise<Response>): void {
	(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
		"or-test";
	vi.stubGlobal("fetch", async (input: unknown) => {
		const url = typeof input === "string" ? input : String(input);
		if (!url.startsWith("https://openrouter.ai/api/v1/")) {
			throw new Error(`OpenRouter 以外への接続は禁止: ${url}`);
		}
		return await respond();
	});
}

/** OpenRouter のキーだけ立てる(応答は別途スタブする)。 */
function stubOpenRouterKey(): void {
	(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
		"or-test";
}

interface OrChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	server_tool_use?: { web_search_requests?: number };
}

/** OpenRouter chat completion の成功レスポンス(本文テキスト + usage)を組み立てる。 */
function orChatMessage(
	fields: Record<string, unknown> | string,
	usage: OrChatUsage,
	finishReason = "stop",
): Response {
	return Response.json({
		choices: [
			{
				finish_reason: finishReason,
				message: {
					content: typeof fields === "string" ? fields : JSON.stringify(fields),
				},
			},
		],
		usage,
	});
}

/**
 * エチケット解析(エージェントループ経路)の成功レスポンス。
 *
 * **最終回答は本文テキストではなく `submit_answer` ツールの呼び出し**として返る。
 * 検証を通ればその場でループを止めるので、応答は1回で足りる
 * (2回目のリクエストは発生しない)。
 */
function orSubmitAnswerResponse(
	fields: Record<string, unknown>,
	usage: OrChatUsage,
): Response {
	return Response.json({
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content: "",
					tool_calls: [
						{
							id: "call_test",
							type: "function",
							function: {
								name: "submit_answer",
								arguments: JSON.stringify(fields),
							},
						},
					],
				},
			},
		],
		usage,
	});
}

/** zoom_photo を1回呼ぶだけの応答。 */
function orZoomResponse(usage: OrChatUsage): Response {
	return Response.json({
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content: "",
					tool_calls: [
						{
							id: "call_zoom",
							type: "function",
							function: {
								name: "zoom_photo",
								arguments: JSON.stringify({
									photoIndex: 0,
									x: 0.3,
									y: 0.4,
									width: 0.2,
									height: 0.2,
								}),
							},
						},
					],
				},
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

/** OpenRouter への outbound を捕まえつつ応答を返す(リクエスト本文を検査するため)。 */
function stubOpenRouterCapturing(
	requests: string[],
	respond: () => Response,
): void {
	(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
		"or-test";
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		if (!url.startsWith("https://openrouter.ai/api/v1/")) {
			throw new Error(`OpenRouter 以外への接続は禁止: ${url}`);
		}
		requests.push(typeof init?.body === "string" ? init.body : "");
		return respond();
	});
}

afterEach(() => {
	delete (env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
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

// ユーザ設定の推論の深さ(low/medium/high)。plan に載って見積・実行記録に効き、
// ジョブ行を経由してコンシューマまで届く(再解決しない)。
describe("plan の effort 解決", () => {
	async function setEffort(userId: string, value: string | null) {
		await env.DB.prepare(
			"UPDATE user SET preferred_reasoning_effort = ? WHERE id = ?",
		)
			.bind(value, userId)
			.run();
	}

	function stubOpenRouterKey() {
		(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
			"or-test";
	}

	it("設定値が plan・見積・実行記録に載る", async () => {
		const userId = await seedUser();
		await setEffort(userId, "high");
		stubOpenRouterKey();
		const plan = await resolveLabelPlan(userId, 1);
		expect(plan.effort).toBe("high");
		expect(plan.estimate).toEqual(
			estimateLabelReserveCharge(plan.route, 1, "high"),
		);
		expect(plan.logBase.effort).toBe("high");
	});

	it("未設定・不正値は low へフォールバックする", async () => {
		stubOpenRouterKey();
		const unset = await seedUser();
		expect((await resolveLabelPlan(unset, 1)).effort).toBe("low");
		const invalid = await seedUser();
		await setEffort(invalid, "ultra");
		expect((await resolveLabelPlan(invalid, 1)).effort).toBe("low");
	});

	it("restore は effort を維持する(再解決しない)", async () => {
		const userId = await seedUser();
		await setEffort(userId, "medium");
		stubOpenRouterKey();
		const plan = await resolveLabelPlan(userId, 2);
		const restored = restoreLabelPlan({
			engine: plan.engine,
			route: plan.route,
			effort: plan.effort,
			photoCount: 2,
			requestId: plan.requestId,
		});
		expect(restored.effort).toBe("medium");
		expect(restored.estimate).toEqual(plan.estimate);
	});

	it("一括抽出の plan にも effort が載る", async () => {
		const userId = await seedUser();
		await setEffort(userId, "medium");
		stubOpenRouterKey();
		const plan = await resolveWineListPlan(userId, 1);
		expect(plan.route).toBe("gpt-luna");
		expect(plan.effort).toBe("medium");
		expect(plan.estimate).toEqual(
			estimateWineListReserveCharge(plan.route, 1, "medium"),
		);
		const restored = restoreWineListPlan({
			route: plan.route,
			effort: plan.effort,
			photoCount: 1,
			requestId: plan.requestId,
		});
		expect(restored.effort).toBe("medium");
	});

	it("キー未設定なら plan を立てず 503 で拒否する(予約しない)", async () => {
		// afterEach でキーを消している状態を使う。別モデルへの自動フォールバックは
		// しない(#602)ので、予約の前に利用不可として扱う。
		const userId = await seedUser();
		expect(isWineListAnalysisAvailable()).toBe(false);
		await expect(resolveLabelPlan(userId, 1)).rejects.toMatchObject({
			status: 503,
		});
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});

	it("high の設定は一括GPTリクエストの reasoning.effort と上限に載る", async () => {
		const userId = await seedUser();
		await setEffort(userId, "high");
		const bodies: string[] = [];
		stubOpenRouterKey();
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			if (typeof init?.body === "string") bodies.push(init.body);
			return orChatMessage(
				{
					wines: [
						{
							wine_name: "Chablis",
							producer: null,
							vintage: null,
							appellation: null,
							region: null,
							grape_varieties: [],
							price: null,
							photo_indexes: [0],
						},
					],
					truncated: false,
				},
				{ prompt_tokens: 100, completion_tokens: 20 },
			);
		});

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false });
		expect(bodies).toHaveLength(1);
		const body = JSON.parse(bodies[0] ?? "{}") as {
			reasoning?: unknown;
			max_tokens?: unknown;
		};
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.max_tokens).toBe(AI_WINE_LIST_GPT_MAX_OUTPUT_TOKENS);
	});

	it("medium の設定はClaudeリクエストの reasoning budget に載る", async () => {
		const userId = await seedPremiumUser();
		await setEffort(userId, "medium");
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		const bodies: string[] = [];
		stubOpenRouterKey();
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			if (typeof init?.body === "string") bodies.push(init.body);
			return orChatMessage(
				{ wine_name: "Chablis" },
				{ prompt_tokens: 100, completion_tokens: 20 },
			);
		});

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false });
		expect(bodies.length).toBeGreaterThan(0);
		const body = JSON.parse(bodies[0] ?? "{}") as {
			reasoning?: unknown;
		};
		expect(body.reasoning).toEqual({ max_tokens: 8000 });
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
		stubOpenRouter(() => Promise.reject(new Error("AI unavailable")));

		// 推論失敗はそのまま呼び出し側へ伝える(返却が例外を握り潰さない #158)。
		// fetch 層の失敗は OpenRouterError に畳まれる(呼び出し側の分岐用)。
		await expect(ask(userId)).rejects.toBeInstanceOf(OpenRouterError);

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
		stubOpenRouter(async () =>
			orChatMessage("キンメリジャンの石灰質土壌です。", {
				prompt_tokens: 30,
				completion_tokens: 12,
			}),
		);

		const result = await ask(userId);

		expect(result).toMatchObject({
			blocked: false,
			answer: "キンメリジャンの石灰質土壌です。",
			actualTokens: 42,
		});
		// 見積との差分は戻るので、最終的な消費は実測ぶんだけ
		const expected = balanceAfter(AI_REGION_QA_MODELS.gemma4.id, {
			inputTokens: 30,
			outputTokens: 12,
		});
		expect(await balanceOf(userId)).toBe(expected);
		expect((result as { balance: number }).balance).toBe(expected);

		const rows = await ledgerRowsOf(userId);
		// 確定は settle 接尾辞の台帳で表す(返却済みかどうかの判別に使う #146)
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
	});

	it("実測が空の応答でも予約全量を消費として確定する(返却0=安全側)", async () => {
		const userId = await seedUser();
		// usage を返さない応答。ここで「実測0」と扱うと予約全額が戻り、消費が無料になる
		stubOpenRouter(async () => orChatMessage("回答", {}));

		const result = await ask(userId);

		expect(result).toMatchObject({ blocked: false });
		expect(await balanceOf(userId)).toBeLessThan(MONTHLY_CREDITS_FREE);
	});

	it("キー未設定なら推論せず 503 で拒否する(予約しない)", async () => {
		// afterEach でキーを消している状態を使う。別モデルへの自動フォールバックは
		// しない(#602)。
		const userId = await seedUser();

		await expect(ask(userId)).rejects.toMatchObject({ status: 503 });

		// 予約前に落ちるので台帳は空(月次付与すら走らない)
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});
});

describe("エチケット解析の予約 → 返却", () => {
	it("全ての写真の解析に失敗したら予約を全額返却する", async () => {
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'standard' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			Response.json({ error: { message: "provider error" } }, { status: 500 }),
		);

		// 個々の写真の失敗はスキップされるが、全滅なら推論失敗として throw する
		await expect(
			runLabelViaJob(userId, { imageDataUrls: [PHOTO, PHOTO] }),
		).rejects.toThrow("すべての写真の解析に失敗しました");

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("OPENROUTER_API_KEY 設定時はClaude経路で解析し、usage合算で確定する", async () => {
		const userId = await seedPremiumUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			orChatMessage(
				{
					wine_name: "Chablis Les Clos",
					producer: "Vincent Dauvissat",
					vintage: 2020,
					appellation: "Chablis Grand Cru",
					region: "Bourgogne",
					grape_varieties: ["Chardonnay"],
				},
				{ prompt_tokens: 1000, completion_tokens: 200 },
			),
		);

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
		// 同じ 1,200 トークンでも標準経路より2桁多く消費する。
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

	it("旧 workers-ai の選択は standard へ読み替えて解析する(互換変換)", async () => {
		// D1 に残る旧値は用途別の対応先へ解決する(#602 の移行対応表)。
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'workers-ai' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			orChatMessage(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: null,
					region: null,
					grape_varieties: [],
				},
				{ prompt_tokens: 1000, completion_tokens: 200 },
			),
		);

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		// 標準経路の実測(1200)で確定 = 旧値が既定の高精度経路に倒れていない
		expect(result).toMatchObject({ blocked: false, actualTokens: 1200 });
	});

	it("高精度経路が失敗したら返却して失敗する(フォールバックしない)", async () => {
		// #602 で OpenAI / Anthropic / Workers AI への直接フォールバックを廃止した。
		// 失敗は予約の返却に載せ、別経路での再実行はしない。
		const userId = await seedPremiumUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			Response.json({ error: { message: "provider error" } }, { status: 500 }),
		);

		await expect(
			runLabelViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toThrow();

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_PREMIUM);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	// Issue #404: 実測が取れないときの床は**実行した経路の見積**。予約額
	// (= 実行した経路の見積。降格が無いので両者は一致する)を使う。
	it("高精度経路が結果を出したなら、実測が空でも床はその経路の見積のまま", async () => {
		const userId = await seedPremiumUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () => orChatMessage({ wine_name: "Chablis" }, {}));

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

// GPT-5.6 Luna 経路(OpenRouter)。既定エンジンなので「キーがあれば黙って走る」ことと、
// 「キーが無いときに利用不可になる」ことの両方を固定する。
describe("エチケット解析のGPT-5.6 Luna経路", () => {
	it("OPENROUTER_API_KEY 設定時はGPT経路で解析し、usage内訳とweb検索回数で確定する", async () => {
		const userId = await seedPremiumUser();
		stubOpenRouter(async () =>
			orSubmitAnswerResponse(
				{
					wine_name: "Chablis Les Clos",
					producer: "Vincent Dauvissat",
					vintage: 2020,
					appellation: "Chablis Grand Cru",
					region: "Bourgogne",
					grape_varieties: ["Chardonnay"],
				},
				{
					prompt_tokens: 1300,
					completion_tokens: 200,
					server_tool_use: { web_search_requests: 3 },
				},
			),
		);

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

	it("参考サイト・価格(IMPL-3): エージェントの指示がモデルへ届き、結果が候補に載る", async () => {
		// 一括抽出の Claude 経路テストと同じく、見たいのは指示文の配線と
		// 応答から候補への持ち回り。検証器が引用を落としても「最後の回答」を
		// 候補にするので、suggestions への到達は変わらない。
		const userId = await seedPremiumUser();
		const requests: string[] = [];
		stubOpenRouterCapturing(requests, () =>
			orSubmitAnswerResponse(
				{
					wine_name: "Chablis Les Clos",
					producer: "Vincent Dauvissat",
					vintage: 2020,
					appellation: "Chablis Grand Cru",
					region: "Bourgogne",
					grape_varieties: ["Chardonnay"],
					reference_links: [
						{ title: "Dauvissat", url: "https://example.com/dauvissat" },
					],
					prices: [{ source: "aaa.com", amount_jpy: 2000, url: null }],
					sources: {},
				},
				{ prompt_tokens: 1300, completion_tokens: 200 },
			),
		);

		const result = await runLabelViaJob(userId, {
			imageDataUrls: [PHOTO],
		});

		expect(result).toMatchObject({ blocked: false });
		if (result.blocked) throw new Error("unreachable");
		expect(requests.length).toBeGreaterThan(0);
		expect(requests[0]).toContain("reference_links");
		expect(requests[0]).toContain("prices");
		expect(result.suggestions.referenceLinks).toEqual([
			{ url: "https://example.com/dauvissat", title: "Dauvissat" },
		]);
		expect(result.suggestions.prices).toEqual([
			{ source: "aaa.com", amountJpy: 2000 },
		]);
	});

	it("GPT経路が失敗したら予約を全額返却する(フォールバックしない)", async () => {
		const userId = await seedPremiumUser();
		stubOpenRouter(async () =>
			Response.json({ error: { message: "bad request" } }, { status: 400 }),
		);

		await expect(
			runLabelViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toThrow();

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_PREMIUM);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("出力上限で打ち切られた応答(length)は成功扱いせず返却する", async () => {
		const userId = await seedPremiumUser();
		// web検索と reasoning が出力枠を使い切ると、本文が途中で切れたまま返る。
		// これを成功として扱うと「形式が不正」という無関係な例外で解析全体が落ちる。
		stubOpenRouter(async () =>
			orChatMessage('{"wine_name":"Chab', { prompt_tokens: 5000 }, "length"),
		);

		await expect(
			runLabelViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toThrow("打ち切られました");

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_PREMIUM);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("選択したエンジンで解析する(Claude選択時はClaudeが走る)", async () => {
		const userId = await seedPremiumUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		const bodies: string[] = [];
		stubOpenRouterCapturing(bodies, () =>
			orChatMessage(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: "Chablis",
					region: null,
					grape_varieties: [],
				},
				{ prompt_tokens: 700, completion_tokens: 70 },
			),
		);

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		// 実測(770)で確定 = GPT経路のトークンが混ざっていない
		expect(result).toMatchObject({ blocked: false, actualTokens: 770 });
		// 選んだ経路のモデルで呼んでいる
		expect(bodies.length).toBeGreaterThan(0);
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
			model: AI_LABEL_WEB_MODEL,
		});
	});

	it("既定(未選択)ではGPT経路を使う", async () => {
		const userId = await seedPremiumUser();
		const bodies: string[] = [];
		stubOpenRouterCapturing(bodies, () =>
			orSubmitAnswerResponse(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: "Chablis",
					region: null,
					grape_varieties: [],
				},
				{ prompt_tokens: 1234, completion_tokens: 0 },
			),
		);

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 1234 });
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
			model: AI_LABEL_GPT_MODEL,
		});
	});

	it("画像変換が使えるときは zoom_photo を渡し、切り出した画像がモデルへ届く", async () => {
		// **この経路の精度を決める往復**。ボトル全体の写真ではラベルの文字が潰れて読めず、
		// 実測では原寸を送っても改善しなかった。効いたのは切り出しだけなので、
		// 「ツールが渡り、結果が画像として次のリクエストに載る」ことを固定する。
		const userId = await seedPremiumUser();
		stubImages();
		const requests: string[] = [];
		let call = 0;
		stubOpenRouterCapturing(requests, () => {
			call += 1;
			// 1回目: 拡大を要求する。2回目: 提出する。
			return call === 1
				? orZoomResponse({ prompt_tokens: 1000, completion_tokens: 100 })
				: orSubmitAnswerResponse(
						{
							wine_name: "Chablis Les Clos",
							producer: "Vincent Dauvissat",
							vintage: 2020,
							appellation: "Chablis Grand Cru",
							region: "Bourgogne",
							grape_varieties: ["Chardonnay"],
						},
						{ prompt_tokens: 1300, completion_tokens: 200 },
					);
		});

		const result = await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false });
		// 1回目のリクエストに zoom_photo がツールとして載る
		expect(requests[0]).toContain("zoom_photo");
		// 2回目のリクエストには切り出した画像が image_url として載る
		// (JSONで座標だけ返しても読めるようにはならない)
		expect(requests[1]).toContain("image_url");
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
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			orChatMessage(
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
				{ prompt_tokens: 3000, completion_tokens: 500 },
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

	it("参考サイト・価格(IMPL-3): 管理下プロンプトの指示がモデルへ届き、結果が候補に載る", async () => {
		// Langfuse の鍵が無いテスト環境ではコードの fallback 本文で動く。
		// 見たいのは「解決済みプロンプトの本文がリクエストに載る」配線と、
		// 応答の reference_links/prices が候補まで届くこと。
		const userId = await seedPremiumUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		const requests: string[] = [];
		stubOpenRouterKey();
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			requests.push(typeof init?.body === "string" ? init.body : "");
			return orChatMessage(
				{
					wines: [
						wineJson({
							wine_name: "Chablis Les Clos",
							producer: "Vincent Dauvissat",
							vintage: 2020,
							appellation: "Chablis Grand Cru",
							photo_indexes: [0],
							reference_links: [
								{ title: "Dauvissat", url: "https://example.com/dauvissat" },
								{ title: "bad", url: "javascript:alert(1)" },
							],
							prices: [
								{ source: "aaa.com", amount_jpy: 2000, url: null },
								{ source: "", amount_jpy: 1000, url: null },
							],
						}),
					],
					truncated: false,
				},
				{ prompt_tokens: 3000, completion_tokens: 500 },
			);
		});

		const result = await runWineListViaJob(userId, {
			imageDataUrls: [PHOTO],
		});

		expect(result).toMatchObject({ blocked: false });
		if (result.blocked) throw new Error("unreachable");
		// 送った指示文に reference_links/prices の出力定義が載っている
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("reference_links");
		expect(requests[0]).toContain("prices");
		// 不正URL・空source の行は落として候補に載る
		expect(result.candidates[0]?.referenceLinks).toEqual([
			{ url: "https://example.com/dauvissat", title: "Dauvissat" },
		]);
		expect(result.candidates[0]?.prices).toEqual([
			{ source: "aaa.com", amountJpy: 2000 },
		]);
	});

	it("既定(gpt-luna)では GPT 経路で解析し、Luna の単価で確定する", async () => {
		const userId = await seedUser();
		stubOpenRouter(async () =>
			orChatMessage(
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
				{ prompt_tokens: 3000, completion_tokens: 500 },
			),
		);

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

	it("選択した経路のモデルで呼ぶ(web-research 選択時は Sonnet)", async () => {
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
		const bodies: string[] = [];
		stubOpenRouterKey();
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			if (typeof init?.body === "string") bodies.push(init.body);
			return orChatMessage(
				{ wines: [wineJson({ wine_name: "Chablis" })], truncated: false },
				{ prompt_tokens: 100, completion_tokens: 20 },
			);
		});

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 120 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.candidates[0]?.suggestions.name).toBe("Chablis");
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
			model: AI_WINE_LIST_ROUTE_MODELS["web-research"],
		});
	});

	it("標準(standard)を選んでいても一括抽出は高精度経路で走る", async () => {
		// エチケット解析は「標準」で単発抽出に落ちるが、一括抽出は降格しない
		// (#358)。ここが落ちると、標準を選んだユーザだけ一括登録が使えなくなる。
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'standard' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			orChatMessage(
				{ wines: [wineJson({ wine_name: "Chablis" })], truncated: false },
				{ prompt_tokens: 100, completion_tokens: 20 },
			),
		);

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 120 });
	});

	it("GPT の応答が出力上限で切れたら予約を全額返却し、写真を分ける案内を返す", async () => {
		// Claude の length と同じ扱いに揃える。structured outputs でも打ち切りは
		// 起きるので、パースに回すと「形式が不正」という無関係な例外になる。
		const userId = await seedUser();
		stubOpenRouter(async () =>
			orChatMessage(
				'{"wines":[{"wine_name":"Chab',
				{ prompt_tokens: 5000, completion_tokens: 20000 },
				"length",
			),
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
		stubOpenRouter(async () =>
			orChatMessage(
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
				{ prompt_tokens: 1000, completion_tokens: 200 },
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
		stubOpenRouter(async () =>
			orChatMessage(
				{ wines: wines.map(wineJson), truncated: false },
				{ prompt_tokens: 1000, completion_tokens: 200 },
			),
		);

		const result = await runWineListViaJob(userId, { imageDataUrls: [PHOTO] });

		if (result.blocked) throw new Error("unreachable");
		expect(result.summary.matchedExisting).toBe(2);
		expect(result.candidates.every((c) => !!c.existing)).toBe(true);
	});

	it("出力が上限で打ち切られたら予約を全額返却し、写真を分ける案内を返す", async () => {
		const userId = await seedUser();
		// length で切れた応答は JSON が途中で終わっている。成功扱いすると
		// 「形式が不正」という無関係な例外になり、ユーザは次の行動を選べない
		stubOpenRouter(async () =>
			orChatMessage(
				'{"wines":[{"wine_name":"Chab',
				{ prompt_tokens: 5000, completion_tokens: 32000 },
				"length",
			),
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

	it("推論呼び出しが失敗したら予約を全額返却する(フォールバックしない)", async () => {
		const userId = await seedUser();
		stubOpenRouter(async () =>
			Response.json({ error: { message: "bad request" } }, { status: 400 }),
		);

		await expect(
			runWineListViaJob(userId, { imageDataUrls: [PHOTO] }),
		).rejects.toThrow();

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
	});

	it("キーが未設定なら予約せずに 503 で拒否する", async () => {
		// OpenRouter の接続が無い環境では機能ごと使えない。afterEach でキーを
		// 消している状態を使う。
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
		stubOpenRouter(async () =>
			orSubmitAnswerResponse(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: "Chablis",
					region: null,
					grape_varieties: [],
				},
				{ prompt_tokens: 1234, completion_tokens: 0 },
			),
		);
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
				model: "openai/gpt-5.6-luna",
				actualTokens: 1234,
				photoCount: 1,
			});
			// 台帳と突き合わせられるよう request_id が載る
			expect(String(logs[0]?.requestId)).toMatch(/^analyze_label:/);
		} finally {
			spy.mockRestore();
		}
	});

	it("標準経路の成功を1行残す(降格ではなく選択として記録される)", async () => {
		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'standard' WHERE id = ?",
		)
			.bind(userId)
			.run();
		stubOpenRouter(async () =>
			orChatMessage(
				{
					wine_name: "Chablis",
					producer: null,
					vintage: null,
					appellation: "Chablis",
					region: null,
					grape_varieties: [],
				},
				{ prompt_tokens: 1000, completion_tokens: 200 },
			),
		);
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});

		try {
			await runLabelViaJob(userId, { imageDataUrls: [PHOTO] });
			const logs = captureInferenceLogs(spy);
			expect(logs).toHaveLength(1);
			// route(選択)と executedBy(実行)が一致する = フォールバックではない。
			expect(logs[0]).toMatchObject({
				outcome: "ok",
				route: "standard",
				executedBy: "standard",
				model: "openai/gpt-5.6-luna",
				actualTokens: 1200,
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
		stubOpenRouterKey();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
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
