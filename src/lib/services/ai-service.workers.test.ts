import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { creditLedger } from "#/db/schema";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { tokensToCredits } from "#/lib/credit/credit-math";
import { REFUND_SUFFIX, SETTLE_SUFFIX } from "#/lib/credit/reservation";
import { NotFoundError } from "#/lib/errors";
import { analyzeWineLabel, answerRegionQuestion } from "./ai-service";

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
	usage: { input_tokens: number; output_tokens: number },
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

afterEach(() => {
	delete (env as unknown as { AI?: unknown }).AI;
	delete (env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
	vi.unstubAllGlobals();
});

/** data URI 1枚ぶんのダミー(中身はスタブが解析しないので任意) */
const PHOTO = "data:image/jpeg;base64,AAAA";

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
		const expected = MONTHLY_CREDITS_FREE - tokensToCredits(actualTokens);
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

describe("analyzeWineLabel の予約 → 返却", () => {
	it("全ての写真の解析に失敗したら予約を全額返却する", async () => {
		const userId = await seedUser();
		stubAiRun(() => Promise.reject(new Error("model error")));

		// 個々の写真の失敗はスキップされるが、全滅なら推論失敗として throw する
		await expect(
			analyzeWineLabel(userId, { imageDataUrls: [PHOTO, PHOTO] }),
		).rejects.toThrow("すべての写真の解析に失敗しました");

		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("ANTHROPIC_API_KEY 設定時はClaude経路で解析し、usage合算で確定する", async () => {
		const userId = await seedUser();
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

		const result = await analyzeWineLabel(userId, {
			imageDataUrls: [PHOTO, PHOTO],
		});

		expect(result).toMatchObject({ blocked: false, actualTokens: 1200 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.suggestions).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
			vintage: 2020,
			regionId: "bourgogne",
			grapeVarietyIds: ["chardonnay"],
		});
		// 実測(1200)ぶんだけ消費し、予約との差分は返る
		expect(await balanceOf(userId)).toBe(
			MONTHLY_CREDITS_FREE - tokensToCredits(1200),
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

		const result = await analyzeWineLabel(userId, { imageDataUrls: [PHOTO] });

		// Workers AI 経路の実測(60)で確定 = Claude経路のトークンが混ざっていない
		expect(result).toMatchObject({ blocked: false, actualTokens: 60 });
	});

	it("Claude経路が失敗したら Workers AI へフォールバックして完了する", async () => {
		const userId = await seedUser();
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

		const result = await analyzeWineLabel(userId, { imageDataUrls: [PHOTO] });

		expect(result).toMatchObject({ blocked: false, actualTokens: 55 });
		if (result.blocked) throw new Error("unreachable");
		expect(result.suggestions.name).toBe("Chablis");
		// フォールバック後も settle で確定し、予約が焼き付かない
		expect(await balanceOf(userId)).toBe(
			MONTHLY_CREDITS_FREE - tokensToCredits(55),
		);
	});

	it("画像が空なら予約せずに 400 で弾く", async () => {
		const userId = await seedUser();

		await expect(
			analyzeWineLabel(userId, { imageDataUrls: [] }),
		).rejects.toThrow();

		// 予約前に落ちるので台帳は空(月次付与すら走らない)
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});
});
