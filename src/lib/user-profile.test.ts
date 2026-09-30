import { describe, expect, it } from "vitest";
import {
	isDisplayableAvatarImage,
	isOwnAvatarImage,
	USER_NAME_MAX,
	userNameSchema,
} from "#/lib/user-profile";

// #636 の純ロジック層。hooks.before(配線は workers テスト)と表示ガードの双方が
// このモジュールを引くため、境界値の正しさはここで押さえる。

describe("userNameSchema", () => {
	it("通常の名前は通る", () => {
		expect(userNameSchema.safeParse("山田 太郎").success).toBe(true);
	});

	it("前後の空白は trim して判定する", () => {
		expect(userNameSchema.safeParse("  山田  ").success).toBe(true);
	});

	it("空文字・空白のみは弾く", () => {
		expect(userNameSchema.safeParse("").success).toBe(false);
		expect(userNameSchema.safeParse("   ").success).toBe(false);
	});

	it(`${USER_NAME_MAX}文字は通り、超過は弾く`, () => {
		expect(userNameSchema.safeParse("a".repeat(USER_NAME_MAX)).success).toBe(
			true,
		);
		expect(
			userNameSchema.safeParse("a".repeat(USER_NAME_MAX + 1)).success,
		).toBe(false);
	});

	it("文字列以外は弾く", () => {
		for (const value of [null, undefined, 123, {}, []]) {
			expect(userNameSchema.safeParse(value).success).toBe(false);
		}
	});

	it("拒否時のメッセージは利用者向けの日本語", () => {
		expect(userNameSchema.safeParse("").error?.issues[0]?.message).toBe(
			"名前を入力してください。",
		);
		expect(
			userNameSchema.safeParse("a".repeat(USER_NAME_MAX + 1)).error?.issues[0]
				?.message,
		).toBe(`名前は${USER_NAME_MAX}文字以内で入力してください。`);
	});
});

describe("isOwnAvatarImage", () => {
	const userId = "abc123XYZ-_";

	it("自分のアバター配信パスは通る", () => {
		for (const ext of ["jpg", "png", "webp", "gif"]) {
			expect(
				isOwnAvatarImage(
					`/api/images/avatars/${userId}.${ext}?v=1234567890`,
					userId,
				),
			).toBe(true);
		}
	});

	it("外部URLは弾く", () => {
		for (const value of [
			"https://evil.example/pixel.png",
			"http://localhost:3000/api/images/avatars/abc123XYZ-_.jpg?v=1",
			"//evil.example/a.jpg",
		]) {
			expect(isOwnAvatarImage(value, userId)).toBe(false);
		}
	});

	it("他人のアバターパスは弾く", () => {
		expect(
			isOwnAvatarImage(`/api/images/avatars/other-user.jpg?v=1`, userId),
		).toBe(false);
		// 前方一致でのすり抜け(`userId` + 余分な文字)は弾く
		expect(
			isOwnAvatarImage(`/api/images/avatars/${userId}x.jpg?v=1`, userId),
		).toBe(false);
	});

	it("クエリ無し・不正な拡張子・不正なクエリは弾く", () => {
		expect(isOwnAvatarImage(`/api/images/avatars/${userId}.jpg`, userId)).toBe(
			false,
		);
		expect(
			isOwnAvatarImage(`/api/images/avatars/${userId}.svg?v=1`, userId),
		).toBe(false);
		expect(
			isOwnAvatarImage(`/api/images/avatars/${userId}.jpg?v=abc`, userId),
		).toBe(false);
	});

	it("非文字列・空のuserIdは弾く", () => {
		expect(isOwnAvatarImage(null, userId)).toBe(false);
		expect(isOwnAvatarImage(`/api/images/avatars/${userId}.jpg?v=1`, "")).toBe(
			false,
		);
	});
});

describe("isDisplayableAvatarImage", () => {
	it("自オリジンのアバターパスは描画する", () => {
		expect(
			isDisplayableAvatarImage("/api/images/avatars/abc123.jpg?v=123"),
		).toBe(true);
		expect(isDisplayableAvatarImage("/api/images/avatars/abc123.png")).toBe(
			true,
		);
	});

	it("外部URL・null・空文字は描画しない", () => {
		for (const value of [
			"https://evil.example/pixel.png",
			"https://lh3.googleusercontent.com/a/avatar",
			null,
			undefined,
			"",
		]) {
			expect(isDisplayableAvatarImage(value)).toBe(false);
		}
	});

	it("avatars 配下を装ったパストラバーサルは描画しない", () => {
		expect(isDisplayableAvatarImage("/api/images/avatars/../secret.jpg")).toBe(
			false,
		);
		expect(isDisplayableAvatarImage("/api/images/wines/u1/b1/a.jpg")).toBe(
			false,
		);
	});
});
