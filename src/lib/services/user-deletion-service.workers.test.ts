import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import { drunkWine } from "#/db/schema";
import { auth } from "#/lib/auth";
import {
	avatarPrefixForUser,
	privateImagePrefixForUser,
} from "#/lib/images/signed-url";
import {
	cleanupAfterUserDelete,
	cleanupBeforeUserDelete,
} from "#/lib/services/user-deletion-service";

// ユーザ削除の後始末(#252)を実D1・実R2の上で検証する。
//
// 以前は remove-user が D1 のドメインテーブルを cascade で消すだけで、Stripe の
// サブスクも R2 のオブジェクトも subscription 行も残った。**アクティブなプレミアム
// 会員を削除すると、アプリ側のユーザだけが消えて課金が継続する**のが最も重い症状。
//
// Stripe API はテストから叩けないため、ここで検証するのは D1 / R2 側の後始末と
// **フックが admin/remove-user 経路で実際に発火すること**。Stripe の解約呼び出しは
// PR の Test Plan で手動確認を依頼している。

const BASE_URL = "http://localhost:3000";
const PASSWORD = "test-password-1234";

// テスト環境ではクライアントIPが解決できず、レートリミットが「パスごとの単一
// 共有バケット」に落ちる(sign-in/sign-up は既定で10秒3回)。複数ユーザを作る
// テストが 429 で落ちるだけなので、認証系を叩く前にカウンタを空にする。
async function resetRateLimit(): Promise<void> {
	await env.DB.prepare("DELETE FROM rate_limit").run();
}

async function signUp(email: string): Promise<string> {
	await resetRateLimit();
	const res = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({ email, password: PASSWORD, name: email }),
		}),
	);
	if (!res.ok) throw new Error(`sign-up failed: ${res.status}`);
	const body = (await res.json()) as { user?: { id?: string } };
	const id = body.user?.id;
	if (!id) throw new Error("sign-up returned no user id");
	return id;
}

async function signInCookie(email: string): Promise<string> {
	await resetRateLimit();
	const res = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({ email, password: PASSWORD }),
		}),
	);
	if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

/** そのユーザの写真・アバターを R2 に置く */
async function seedObjects(userId: string): Promise<void> {
	await env.AVATARS.put(`wines/${userId}/entry-1/photo-1.jpg`, "photo-1");
	await env.AVATARS.put(`wines/${userId}/entry-2/photo-2.jpg`, "photo-2");
	await env.AVATARS.put(`avatars/${userId}.png`, "avatar");
}

async function countObjects(prefix: string): Promise<number> {
	return (await env.AVATARS.list({ prefix })).objects.length;
}

/** stripeSubscriptionId を持たない subscription 行(Stripe API を呼ばせない) */
async function seedSubscriptionRow(userId: string, id: string): Promise<void> {
	await db.insert(subscription).values({
		id,
		plan: "premium",
		referenceId: userId,
		status: "active",
	});
}

async function countSubscriptionRows(userId: string): Promise<number> {
	return (
		await db
			.select({ id: subscription.id })
			.from(subscription)
			.where(eq(subscription.referenceId, userId))
	).length;
}

let admin: { id: string; cookie: string };

beforeAll(async () => {
	const id = await signUp("admin@example.test");
	// 初回の admin 付与は本番でも手動 UPDATE。テストでも同じ形で昇格させる
	await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?")
		.bind(id)
		.run();
	admin = { id, cookie: await signInCookie("admin@example.test") };
});

describe("cleanupBeforeUserDelete / cleanupAfterUserDelete", () => {
	it("subscription 行を消し、R2 の写真とアバターを消す", async () => {
		const userId = await signUp("cleanup-target@example.test");
		await seedObjects(userId);
		await seedSubscriptionRow(userId, "sub-cleanup-1");

		expect(await countSubscriptionRows(userId)).toBe(1);
		expect(await countObjects(privateImagePrefixForUser(userId))).toBe(2);
		expect(await countObjects(avatarPrefixForUser(userId))).toBe(1);

		await cleanupBeforeUserDelete(userId);
		await cleanupAfterUserDelete(userId);

		expect(await countSubscriptionRows(userId)).toBe(0);
		expect(await countObjects(privateImagePrefixForUser(userId))).toBe(0);
		expect(await countObjects(avatarPrefixForUser(userId))).toBe(0);
	});

	// userId は連番ではないので実際には衝突しにくいが、接頭辞の切り方を間違えると
	// (末尾の "/" や "." を落とすと)他人のデータを消す。境界を明示的に固定する。
	it("接頭辞が前方一致する別ユーザのオブジェクトは消さない", async () => {
		const userId = "prefix-victim";
		const neighborId = `${userId}-extra`;
		await seedObjects(userId);
		await seedObjects(neighborId);

		await cleanupAfterUserDelete(userId);

		expect(await countObjects(privateImagePrefixForUser(userId))).toBe(0);
		expect(await countObjects(privateImagePrefixForUser(neighborId))).toBe(2);
		expect(await countObjects(avatarPrefixForUser(neighborId))).toBe(1);
	});

	it("消すものが無いユーザでも失敗しない", async () => {
		const userId = await signUp("cleanup-empty@example.test");
		await expect(cleanupBeforeUserDelete(userId)).resolves.toBeUndefined();
		await expect(cleanupAfterUserDelete(userId)).resolves.toBeUndefined();
	});
});

describe("admin の remove-user 経路", () => {
	// **このテストがこのPRの中核**。後始末を `user.deleteUser.beforeDelete` に
	// 置くと、あちらは本人によるセルフ退会(/delete-user)専用のフックなので
	// admin/remove-user では発火せず、このテストだけが落ちる。
	it("R2 のオブジェクトと subscription 行まで後始末される", async () => {
		const email = "remove-target@example.test";
		const userId = await signUp(email);
		await seedObjects(userId);
		await seedSubscriptionRow(userId, "sub-remove-1");
		// cascade の対象(ドメインテーブル)も1件置いて、従来どおり消えることを見る
		await db.insert(drunkWine).values({
			id: "entry-remove-1",
			userId,
			aopId: "chablis",
			name: "test",
		});

		const res = await auth.handler(
			new Request(`${BASE_URL}/api/auth/admin/remove-user`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: BASE_URL,
					cookie: admin.cookie,
				},
				body: JSON.stringify({ userId }),
			}),
		);
		expect(res.status, await res.clone().text()).toBe(200);

		// user 行と cascade 対象(従来から消えていた分)
		const users = await env.DB.prepare("SELECT id FROM user WHERE id = ?")
			.bind(userId)
			.all();
		expect(users.results.length).toBe(0);
		expect(
			(
				await db
					.select({ id: drunkWine.id })
					.from(drunkWine)
					.where(eq(drunkWine.userId, userId))
			).length,
		).toBe(0);

		// #252 で残っていた分
		expect(await countSubscriptionRows(userId)).toBe(0);
		expect(await countObjects(privateImagePrefixForUser(userId))).toBe(0);
		expect(await countObjects(avatarPrefixForUser(userId))).toBe(0);
	});
});
