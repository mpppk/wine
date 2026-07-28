import { describe, expect, it } from "vitest";
import { extensionIdempotencyKey, isStripeRequestRejected } from "./redemption";

describe("isStripeRequestRejected", () => {
	it("treats stripe's client-side rejections as not applied", () => {
		for (const type of [
			"invalid_request_error",
			"authentication_error",
			"permission_error",
			"rate_limit_error",
			"card_error",
		]) {
			expect(isStripeRequestRejected({ type })).toBe(true);
		}
	});

	it("treats stripe api errors and connection failures as unknown", () => {
		// 5xx・ネットワーク断は「適用済みだが応答が失われた」と区別できない。
		expect(isStripeRequestRejected({ type: "api_error" })).toBe(false);
		expect(isStripeRequestRejected({ type: "api_connection_error" })).toBe(
			false,
		);
		expect(isStripeRequestRejected(new Error("fetch failed"))).toBe(false);
	});

	it("treats idempotency errors as unknown so the redemption row is kept", () => {
		// 同じキーで異なるパラメータ = 1回目が適用済み。ここで再引換を許すと二重延長になる。
		expect(isStripeRequestRejected({ type: "idempotency_error" })).toBe(false);
	});

	it("does not crash on non-object rejections", () => {
		expect(isStripeRequestRejected(null)).toBe(false);
		expect(isStripeRequestRejected(undefined)).toBe(false);
		expect(isStripeRequestRejected("invalid_request_error")).toBe(false);
	});
});

describe("extensionIdempotencyKey", () => {
	it("is stable for the same user and code", () => {
		expect(extensionIdempotencyKey("user-1", "WINE7")).toBe(
			extensionIdempotencyKey("user-1", "WINE7"),
		);
	});

	it("differs per user and per code", () => {
		expect(extensionIdempotencyKey("user-1", "WINE7")).not.toBe(
			extensionIdempotencyKey("user-2", "WINE7"),
		);
		expect(extensionIdempotencyKey("user-1", "WINE7")).not.toBe(
			extensionIdempotencyKey("user-1", "SUMMER"),
		);
	});

	it("stays within stripe's 255 character limit", () => {
		// code は server fn の入力検証で 64 文字以下。userId が伸びても超えないこと。
		const key = extensionIdempotencyKey("u".repeat(255), "C".repeat(64));
		expect(key.length).toBeLessThanOrEqual(255);
	});
});
