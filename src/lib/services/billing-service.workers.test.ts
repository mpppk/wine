import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import { couponRedemption } from "#/db/schema";
import { extensionIdempotencyKey } from "#/lib/billing/campaign-codes";
import { ConflictError } from "#/lib/errors";

// 引換コードの補償(#248)を実D1の上で検証する。
//
// 以前は Stripe 延長が失敗すると理由を問わず引換行を削除していた。「Stripe は適用済みで
// 応答だけが失われた」場合もこれに当たるため、ユーザは同じコードをもう一度使えて
// **二重に延長できた**(7日コードで計14日)。残高と違って契約期間の二重適用は台帳に
// 痕跡が残らず、後から検知も取り消しもできない。
//
// Stripe API はテストから叩けないので、クライアントだけモックして
// 「どう失敗したときに引換行がどうなるか」を固定する。

const stripe = vi.hoisted(() => ({
	retrieve: vi.fn(),
	update: vi.fn(),
}));

vi.mock("#/lib/billing/stripe-client", () => ({
	stripeClient: { subscriptions: stripe },
}));

const { redeemExtensionCode } = await import("#/lib/services/billing-service");

/** vitest.config.ts の CAMPAIGN_EXTENSION_CODES に合わせる */
const CODE = "TESTCODE";
const DAYS = 7;
const PERIOD_END = 1_800_000_000;

/** Stripe SDK のエラーの形(分類に使う属性だけ) */
function stripeError(fields: { statusCode?: number; rawType?: string }): Error {
	return Object.assign(new Error("stripe failed"), fields);
}

let userId: string;

async function seedPremiumUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "premium", `${id}@example.test`)
		.run();
	await db.insert(subscription).values({
		id: crypto.randomUUID(),
		plan: "premium",
		referenceId: id,
		status: "active",
		stripeSubscriptionId: `sub_${id}`,
	});
	return id;
}

async function countRedemptions(): Promise<number> {
	return (
		await db
			.select({ id: couponRedemption.id })
			.from(couponRedemption)
			.where(
				and(
					eq(couponRedemption.userId, userId),
					eq(couponRedemption.code, CODE),
				),
			)
	).length;
}

beforeEach(async () => {
	vi.clearAllMocks();
	stripe.retrieve.mockResolvedValue({
		items: { data: [{ current_period_end: PERIOD_END }] },
	});
	stripe.update.mockResolvedValue({});
	userId = await seedPremiumUser();
});

describe("redeemExtensionCode", () => {
	it("延長に成功すると引換が記録され、日数分だけ後ろ倒しになる", async () => {
		const result = await redeemExtensionCode(userId, CODE);

		expect(result).toEqual({
			extendedDays: DAYS,
			newPeriodEnd: (PERIOD_END + DAYS * 24 * 60 * 60) * 1000,
		});
		expect(await countRedemptions()).toBe(1);
		// 2回目は unique 制約で弾かれ、Stripe も叩かれない(#145)
		stripe.update.mockClear();
		await expect(redeemExtensionCode(userId, CODE)).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(stripe.update).not.toHaveBeenCalled();
	});

	// 応答が失われても Stripe 側で二度目の延長が起きないようにする多重防御。
	it("Stripe の延長に引換ごとの冪等キーを渡す", async () => {
		await redeemExtensionCode(userId, CODE.toLowerCase());

		expect(stripe.update).toHaveBeenCalledWith(
			`sub_${userId}`,
			{
				trial_end: PERIOD_END + DAYS * 24 * 60 * 60,
				proration_behavior: "none",
			},
			{ idempotencyKey: extensionIdempotencyKey(userId, CODE) },
		);
	});

	// **このPRの中核**。修正前はここで引換行が消え、同じコードで再び延長できた。
	it("結果不明な失敗では引換行を残し、再引換を許さない", async () => {
		stripe.update.mockRejectedValue(stripeError({ statusCode: 500 }));

		await expect(redeemExtensionCode(userId, CODE)).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(await countRedemptions()).toBe(1);

		// 再送しても Stripe は叩かれない = 二重延長にならない
		stripe.update.mockClear();
		await expect(redeemExtensionCode(userId, CODE)).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(stripe.update).not.toHaveBeenCalled();
	});

	it("冪等キー衝突(先行リクエストが受理済み)でも引換行を残す", async () => {
		stripe.update.mockRejectedValue(
			stripeError({ statusCode: 400, rawType: "idempotency_error" }),
		);

		await expect(redeemExtensionCode(userId, CODE)).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(await countRedemptions()).toBe(1);
	});

	// 逆側。Stripe が受け取って拒否した(副作用なし)なら、コードを取り上げてはいけない。
	it("Stripe が 4xx で拒否した場合は引換行を巻き戻して再挑戦できる", async () => {
		stripe.update.mockRejectedValueOnce(
			stripeError({ statusCode: 400, rawType: "invalid_request_error" }),
		);

		await expect(redeemExtensionCode(userId, CODE)).rejects.toThrow(
			"stripe failed",
		);
		expect(await countRedemptions()).toBe(0);

		// 原因が解消すれば同じコードで引換できる
		await expect(redeemExtensionCode(userId, CODE)).resolves.toMatchObject({
			extendedDays: DAYS,
		});
		expect(await countRedemptions()).toBe(1);
	});

	// 書き込みを発行する前の失敗(プレミアムでない等)は Stripe に何も送っていない。
	it("プレミアムでなければ引換行を残さない", async () => {
		await db.delete(subscription).where(eq(subscription.referenceId, userId));

		await expect(redeemExtensionCode(userId, CODE)).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(stripe.update).not.toHaveBeenCalled();
		expect(await countRedemptions()).toBe(0);
	});

	// 補償の削除自体が落ちると、修正前は Stripe の失敗理由がどこにも残らず
	// 「引換行だけ残ってコードが恒久的に使えない」状態の説明が付かなかった(#158 と同型)。
	// 実D1でトリガを張って DELETE を失敗させる。
	it("補償の削除が失敗しても Stripe の元例外を投げ直す", async () => {
		stripe.update.mockRejectedValue(
			stripeError({ statusCode: 400, rawType: "invalid_request_error" }),
		);
		await env.DB.prepare(
			`CREATE TRIGGER block_redemption_delete BEFORE DELETE ON coupon_redemption
			 BEGIN SELECT RAISE(ABORT, 'delete blocked'); END`,
		).run();
		try {
			// 投げ直されるのは削除の失敗ではなく Stripe の失敗
			await expect(redeemExtensionCode(userId, CODE)).rejects.toThrow(
				"stripe failed",
			);
			expect(await countRedemptions()).toBe(1);
		} finally {
			await env.DB.prepare("DROP TRIGGER block_redemption_delete").run();
		}
	});

	it("未定義のコードは Stripe を叩かず記録も残さない", async () => {
		await expect(redeemExtensionCode(userId, "NOPE")).rejects.toThrow(
			"コードが正しくありません。",
		);
		expect(stripe.retrieve).not.toHaveBeenCalled();
		expect(await countRedemptions()).toBe(0);
	});
});
