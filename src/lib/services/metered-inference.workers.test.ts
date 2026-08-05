import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { creditLedger } from "#/db/schema";
import { MICRO_USD_PER_CREDIT } from "#/lib/billing/ai-pricing";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { REFUND_SUFFIX, SETTLE_SUFFIX } from "#/lib/credit/reservation";
import {
	type MeteredInferenceContext,
	runMeteredInference,
} from "./metered-inference";

// runMeteredInference は「予約 → 推論 → 実測確定 / 失敗時返却」の唯一のチョークポイント
// (#392)。ここが守る順序制約は過去すべて実害を出しており(#144/#158/#245/#370)、しかも
// typecheck が一切強制しない。3つの AI 機能を通した間接的な検証(ai-service.workers.test.ts)
// とは別に、**ラッパー単体**で不変条件を固定する —— 4つ目の機能はこの関数だけを信じて
// 書かれるため。
//
// 実D1で回す(vitest の workers プロジェクト)。推論本体はテスト側の関数を渡すので、
// AI バインディングは要らない。

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "metered-user", `${id}@example.test`)
		.run();
	return id;
}

async function balanceOf(userId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT balance FROM credit_balance WHERE user_id = ?",
	)
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

async function ledgerRowsOf(userId: string) {
	return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

const LOG_BASE = {
	feature: "region_qa",
	selected: "gemma4",
	route: "gemma4",
	model: "@cf/google/gemma-4",
} as const;

/** 1クレジットぶんの見積(予約額)。 */
const ESTIMATE = { microUsd: MICRO_USD_PER_CREDIT, tokens: 0 };

function requestId(): string {
	return `metered_test:${crypto.randomUUID()}`;
}

/** console.info / console.warn の JSON 行から ai inference の実行記録だけを拾う。 */
function captureInferenceLogs(spy: {
	mock: { calls: unknown[][] };
}): Array<Record<string, unknown>> {
	const lines: Array<Record<string, unknown>> = [];
	for (const call of spy.mock.calls) {
		try {
			const parsed = JSON.parse(String(call[0])) as Record<string, unknown>;
			if (parsed.msg === "ai inference") lines.push(parsed);
		} catch {
			// 実行記録以外の出力は無視する
		}
	}
	return lines;
}

describe("runMeteredInference", () => {
	it("成功すると実測で確定し、返却行は立たない", async () => {
		const userId = await seedUser();
		const id = requestId();
		// 予約(1クレジット)より小さい実測。差額は settle 側で戻る。
		const charge = { microUsd: MICRO_USD_PER_CREDIT, tokens: 42 };

		const result = await runMeteredInference(
			userId,
			{ estimate: ESTIMATE, requestId: id, logBase: LOG_BASE },
			async () => ({ value: "answer", charge }),
		);

		expect(result).toMatchObject({
			blocked: false,
			value: "answer",
			charge,
		});
		if (result.blocked) throw new Error("unreachable");
		// 残高は台帳の確定後の値がそのまま返る(呼び出し側が再取得しなくてよい)。
		expect(result.balance).toBe(await balanceOf(userId));
		expect(result.balance).toBeLessThan(MONTHLY_CREDITS_FREE);

		const rows = await ledgerRowsOf(userId);
		const requestIds = rows.map((r) => r.requestId);
		expect(requestIds).toContain(id);
		expect(requestIds).toContain(`${id}${SETTLE_SUFFIX}`);
		// 成功経路で返却が走ると消費がネットプラスになる。
		expect(requestIds).not.toContain(`${id}${REFUND_SUFFIX}`);
	});

	it("推論が失敗すると予約を全額返却し、元の例外をそのまま伝播する(#158)", async () => {
		const userId = await seedUser();
		const id = requestId();
		const boom = new Error("inference exploded");

		await expect(
			runMeteredInference(
				userId,
				{ estimate: ESTIMATE, requestId: id, logBase: LOG_BASE },
				async () => {
					throw boom;
				},
			),
			// ラッパーが独自のエラーへ包み替えると、呼び出し側の HttpError 判定や
			// cause の追跡(#156)が壊れる。同一インスタンスであることを見る。
		).rejects.toBe(boom);

		// 月次付与は予約時に遅延実行されるので、比較対象は付与後の満額。
		// 1クレジットも焼き付いていないことを見る(#144 で消えたのがここ)。
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const requestIds = (await ledgerRowsOf(userId)).map((r) => r.requestId);
		expect(requestIds).toContain(`${id}${REFUND_SUFFIX}`);
		expect(requestIds).not.toContain(`${id}${SETTLE_SUFFIX}`);
	});

	it("残高不足なら推論を呼ばず blocked を返す(throw しない)", async () => {
		const userId = await seedUser();
		const infer = vi.fn();

		const result = await runMeteredInference(
			userId,
			{
				// 無料枠(150クレジット)を超える見積。
				estimate: {
					microUsd: MICRO_USD_PER_CREDIT * (MONTHLY_CREDITS_FREE + 1),
					tokens: 0,
				},
				requestId: requestId(),
				logBase: LOG_BASE,
			},
			infer,
		);

		expect(result.blocked).toBe(true);
		if (!result.blocked) throw new Error("unreachable");
		expect(result.required).toBeGreaterThan(result.balance);
		// 残高不足は「失敗」ではない。推論を走らせない(=原価を発生させない)のが要点。
		expect(infer).not.toHaveBeenCalled();
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
	});

	it("推論本体には requestId と予約額を渡す(実測欠落時の床に要る)", async () => {
		const userId = await seedUser();
		const id = requestId();
		let seen: MeteredInferenceContext | undefined;

		await runMeteredInference(
			userId,
			{ estimate: ESTIMATE, requestId: id, logBase: LOG_BASE },
			async (ctx) => {
				seen = ctx;
				// 実測が取れなかった経路の再現: 予約額をそのまま確定値にする。
				return {
					value: null,
					charge: { microUsd: ctx.reservedMicroUsd, tokens: 0 },
				};
			},
		);

		expect(seen?.requestId).toBe(id);
		expect(seen?.reservedMicroUsd).toBe(ESTIMATE.microUsd);
	});

	describe("実行記録", () => {
		it("成功時に1行出し、addLogFields の内容を載せる", async () => {
			const userId = await seedUser();
			const spy = vi.spyOn(console, "info").mockImplementation(() => {});
			try {
				await runMeteredInference(
					userId,
					{ estimate: ESTIMATE, requestId: requestId(), logBase: LOG_BASE },
					async (ctx) => {
						ctx.addLogFields({ executedBy: "gemma4" });
						return {
							value: null,
							charge: { microUsd: MICRO_USD_PER_CREDIT, tokens: 7 },
						};
					},
				);
				const logs = captureInferenceLogs(spy);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					feature: "region_qa",
					userId,
					outcome: "ok",
					route: "gemma4",
					executedBy: "gemma4",
					fellBack: false,
					actualTokens: 7,
					costMicroUsd: MICRO_USD_PER_CREDIT,
					reservedMicroUsd: ESTIMATE.microUsd,
				});
			} finally {
				spy.mockRestore();
			}
		});

		it("失敗時にも addLogFields の内容を載せる(降格・裏取りの記録が消えない)", async () => {
			const userId = await seedUser();
			// 高精度経路が途中まで進んで落ちた回の再現。executedBy/webResearch を
			// failed に載せないと「検索まで到達したか」が追えなくなる(#392 のドリフト)。
			const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await expect(
					runMeteredInference(
						userId,
						{ estimate: ESTIMATE, requestId: requestId(), logBase: LOG_BASE },
						async (ctx) => {
							ctx.addLogFields({ executedBy: "workers-ai" });
							throw new Error("settle failed");
						},
					),
				).rejects.toThrow("settle failed");

				const logs = captureInferenceLogs(spy);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					outcome: "failed",
					route: "gemma4",
					executedBy: "workers-ai",
					// route と executedBy が揃うので降格が判定できる。
					fellBack: true,
					reservedMicroUsd: ESTIMATE.microUsd,
				});
			} finally {
				spy.mockRestore();
			}
		});

		it("残高不足でも1行出す(#370。無言で返さない)", async () => {
			const userId = await seedUser();
			const spy = vi.spyOn(console, "info").mockImplementation(() => {});
			try {
				await runMeteredInference(
					userId,
					{
						estimate: {
							microUsd: MICRO_USD_PER_CREDIT * (MONTHLY_CREDITS_FREE + 1),
							tokens: 0,
						},
						requestId: requestId(),
						logBase: LOG_BASE,
					},
					async () => {
						throw new Error("推論は呼ばれない");
					},
				);
				const logs = captureInferenceLogs(spy);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					outcome: "blocked",
					feature: "region_qa",
					userId,
				});
				// 推論に到達していないので実行経路は載せない(載せると
				// 「フォールバックしなかった」と誤読される。inference-log.ts 参照)。
				expect(logs[0]).not.toHaveProperty("executedBy");
				expect(logs[0]).not.toHaveProperty("fellBack");
			} finally {
				spy.mockRestore();
			}
		});
	});
});
