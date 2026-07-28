import { describe, expect, it } from "vitest";
import {
	classifyStripeWriteFailure,
	issueStripeWrite,
	isUnconfirmedStripeWrite,
	StripeWriteFailure,
} from "./stripe-write";

// この分類が「引換行を巻き戻してよいか」をそのまま決める(#248)。
// 誤って "rejected" と判定すると、適用済みの延長に対して引換行を消してしまい、
// 同じコードでもう一度延長できる = 二重延長になる。

/** Stripe SDK が投げるエラーの形(必要な属性だけ) */
function stripeError(fields: {
	statusCode?: number;
	rawType?: string;
	type?: string;
}): Error {
	return Object.assign(new Error("stripe failed"), fields);
}

describe("classifyStripeWriteFailure", () => {
	it("4xx は Stripe が受け取って突き返した=副作用なしとみなす", () => {
		expect(
			classifyStripeWriteFailure(
				stripeError({ statusCode: 400, rawType: "invalid_request_error" }),
			),
		).toBe("rejected");
		// 429(レートリミット)も Stripe が実行前に弾いた形なので巻き戻して安全
		expect(
			classifyStripeWriteFailure(
				stripeError({ statusCode: 429, rawType: "rate_limit_error" }),
			),
		).toBe("rejected");
	});

	it("ステータスを持たない失敗(接続断・タイムアウト)は結果不明", () => {
		expect(
			classifyStripeWriteFailure(
				stripeError({ type: "StripeConnectionError" }),
			),
		).toBe("unknown");
		expect(classifyStripeWriteFailure(new Error("network error"))).toBe(
			"unknown",
		);
		expect(classifyStripeWriteFailure("boom")).toBe("unknown");
	});

	it("5xx は Stripe 側で処理が始まっていたか分からないので結果不明", () => {
		expect(
			classifyStripeWriteFailure(
				stripeError({ statusCode: 500, rawType: "api_error" }),
			),
		).toBe("unknown");
	});

	// idempotency_error は 400 で返るが意味が逆で、「先行リクエストが受理済み」の合図。
	// 4xx の一括扱いに混ぜると「拒否された」と誤読して二重適用を招く。
	it("冪等キー衝突は 400 でも結果不明として扱う", () => {
		expect(
			classifyStripeWriteFailure(
				stripeError({ statusCode: 400, rawType: "idempotency_error" }),
			),
		).toBe("unknown");
		expect(
			classifyStripeWriteFailure(
				stripeError({ statusCode: 400, type: "StripeIdempotencyError" }),
			),
		).toBe("unknown");
	});
});

describe("issueStripeWrite / isUnconfirmedStripeWrite", () => {
	it("成功時は戻り値をそのまま返す", async () => {
		await expect(issueStripeWrite(async () => "ok")).resolves.toBe("ok");
	});

	it("失敗を包み、元エラーと文言を保つ", async () => {
		const cause = stripeError({ statusCode: 500 });
		const err = await issueStripeWrite(async () => {
			throw cause;
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(StripeWriteFailure);
		expect((err as StripeWriteFailure).cause).toBe(cause);
		// UI に出る文言を変えない(profile の onError は err.message を表示する)
		expect((err as Error).message).toBe("stripe failed");
	});

	// 書き込みを発行する前に落ちた失敗は、そもそも Stripe に何も送っていない。
	// ここを「不明」に倒すと、プレミアムでないユーザのコードが毎回消費されてしまう。
	it("包まれていないエラーは結果不明ではない", () => {
		expect(isUnconfirmedStripeWrite(new Error("before the write"))).toBe(false);
		expect(isUnconfirmedStripeWrite(undefined)).toBe(false);
	});

	it("包まれた失敗は分類に従って結果不明を報告する", async () => {
		const unknown = await issueStripeWrite(async () => {
			throw stripeError({ type: "StripeConnectionError" });
		}).catch((e: unknown) => e);
		expect(isUnconfirmedStripeWrite(unknown)).toBe(true);

		const rejected = await issueStripeWrite(async () => {
			throw stripeError({ statusCode: 404, rawType: "invalid_request_error" });
		}).catch((e: unknown) => e);
		expect(isUnconfirmedStripeWrite(rejected)).toBe(false);
	});
});
