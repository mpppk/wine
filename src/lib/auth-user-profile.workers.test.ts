import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	signUpEmailRequest,
	signUpTestUser,
	updateUserRequest,
} from "#/lib/auth-test-helpers";
import { USER_NAME_MAX } from "#/lib/user-profile";

// #636: image/name は better-auth のハンドラ直結でアプリ側 zod を通らないため、
// hooks.before(src/lib/auth.ts)で /update-user と /sign-up/email の body を検証する。
// 純ロジック(スキーマ・URL照合)の境界値は user-profile.test.ts、ここでは
// auth.handler 経由で 400 になること・正規値が D1 に書かれること(配線)を見る。

const EMAIL = "user-profile-636@example.com";
const PASSWORD = "test-password-636";

let cookie = "";
let userId = "";

beforeAll(async () => {
	({ cookie, userId } = await signUpTestUser({
		name: "user636",
		email: EMAIL,
		password: PASSWORD,
	}));
});

/** update-user を叩く(プロフィール画面の authClient.updateUser と同じ経路) */
function updateUser(body: Record<string, unknown>): Promise<Response> {
	return updateUserRequest(cookie, body);
}

async function storedUser(): Promise<{ name: string; image: string | null }> {
	const row = await env.DB.prepare("SELECT name, image FROM user WHERE id = ?")
		.bind(userId)
		.first<{ name: string; image: string | null }>();
	expect(row).not.toBeNull();
	return { name: row?.name ?? "", image: row?.image ?? null };
}

describe("update-user の image は自分のアバター配信パスのみ (#636)", () => {
	it("外部URLは 400 で弾かれ、D1 は書き換わらない", async () => {
		const before = await storedUser();
		const res = await updateUser({ image: "https://evil.example/pixel.png" });
		expect(res.status).toBe(400);
		expect(await storedUser()).toEqual(before);
	});

	it("他人のアバターパスは 400 で弾かれる", async () => {
		const before = await storedUser();
		const res = await updateUser({
			image: "/api/images/avatars/someone-else.jpg?v=123",
		});
		expect(res.status).toBe(400);
		expect(await storedUser()).toEqual(before);
	});

	it("自分のアバター配信パスは通り、D1 に保存される", async () => {
		const own = `/api/images/avatars/${userId}.jpg?v=1234567890`;
		const res = await updateUser({ image: own });
		expect(res.status).toBe(200);
		expect((await storedUser()).image).toBe(own);
	});

	it("image: null(削除)は通る", async () => {
		const res = await updateUser({ image: null });
		expect(res.status).toBe(200);
		expect((await storedUser()).image).toBeNull();
	});
});

describe("update-user の name は trim 後 1〜N 文字 (#636)", () => {
	it("過長 name は 400 で弾かれ、D1 は書き換わらない", async () => {
		const before = await storedUser();
		const res = await updateUser({ name: "a".repeat(USER_NAME_MAX + 1) });
		expect(res.status).toBe(400);
		expect(await storedUser()).toEqual(before);
	});

	it("空白のみの name は 400 で弾かれる", async () => {
		const before = await storedUser();
		const res = await updateUser({ name: "   " });
		expect(res.status).toBe(400);
		expect(await storedUser()).toEqual(before);
	});

	it("通常の name 更新は従来どおり通る", async () => {
		const res = await updateUser({ name: "renamed636" });
		expect(res.status).toBe(200);
		expect((await storedUser()).name).toBe("renamed636");
	});
});

describe("sign-up/email の image・name も同じ関門を通る (#636)", () => {
	const rejections: Array<{
		title: string;
		email: string;
		name: string;
		image?: string;
	}> = [
		{
			title: "image 付きのサインアップは 400 で弾かれ、ユーザは作られない",
			email: "user-profile-636-image@example.com",
			name: "evil",
			image: "https://evil.example/pixel.png",
		},
		{
			title: "過長 name のサインアップは 400 で弾かれ、ユーザは作られない",
			email: "user-profile-636-name@example.com",
			name: "a".repeat(USER_NAME_MAX + 1),
		},
	];
	it.each(rejections)("$title", async ({ email, name, image }) => {
		const res = await signUpEmailRequest({
			name,
			email,
			password: PASSWORD,
			...(image ? { image } : {}),
		});
		expect(res.status).toBe(400);
		const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
			.bind(email)
			.first<{ id: string }>();
		expect(row).toBeNull();
	});
});
