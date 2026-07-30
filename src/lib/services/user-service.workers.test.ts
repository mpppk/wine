import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { isUserBanned } from "./user-service";

// BAN 判定は MCP(`/api/mcp`)の入口ガードが毎リクエスト使う(#330)。判定に使う
// banned / ban_expires は better-auth が書く列なので、実 D1 の行に対して固定する。

let seq = 0;
async function freshUser(values: {
	banned?: boolean | null;
	banExpires?: Date | null;
}): Promise<string> {
	seq += 1;
	const id = `user-service-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "user service tester",
		email: `${id}@example.com`,
		emailVerified: false,
		banned: values.banned ?? null,
		banExpires: values.banExpires ?? null,
	});
	return id;
}

describe("isUserBanned", () => {
	let now: number;
	beforeEach(() => {
		now = Date.now();
	});

	it("BANされていないユーザは false", async () => {
		expect(await isUserBanned(await freshUser({}))).toBe(false);
		expect(await isUserBanned(await freshUser({ banned: false }))).toBe(false);
	});

	it("無期限BANのユーザは true", async () => {
		expect(await isUserBanned(await freshUser({ banned: true }))).toBe(true);
	});

	it("期限が未来のBANは true、期限切れのBANは false", async () => {
		const active = await freshUser({
			banned: true,
			banExpires: new Date(now + 60_000),
		});
		const expired = await freshUser({
			banned: true,
			banExpires: new Date(now - 60_000),
		});
		expect(await isUserBanned(active)).toBe(true);
		// better-auth の自動解除はサインイン時にしか走らないので、MCP 経路は
		// 期限を自分で見る(期限切れ後も締め出したままにしない)。
		expect(await isUserBanned(expired)).toBe(false);
	});

	it("存在しないユーザ(削除済み)は拒否側に倒す", async () => {
		expect(await isUserBanned("no-such-user")).toBe(true);
	});
});
