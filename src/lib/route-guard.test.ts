import { beforeEach, describe, expect, it, vi } from "vitest";

// server function は Cloudflare 依存を引き込むためモックする。
const getSession = vi.fn();
vi.mock("#/server/auth", () => ({
	getSession: () => getSession(),
}));

const { requireAuthBeforeLoad } = await import("./route-guard");
const { requireAdminBeforeLoad } = await import("./admin/route-guard");

// redirect() が投げる値から遷移先を取り出す(実装の内部形状に依存しすぎないよう
// 代表的な置き場所を順に見る)。
function redirectTarget(thrown: unknown): unknown {
	const r = thrown as { to?: unknown; options?: { to?: unknown } };
	return r?.to ?? r?.options?.to;
}

function session(overrides: Record<string, unknown> = {}) {
	return { user: { id: "u1", role: "user", banned: false, ...overrides } };
}

describe("requireAuthBeforeLoad", () => {
	beforeEach(() => {
		getSession.mockReset();
	});

	it("未ログインなら /login へリダイレクトする", async () => {
		getSession.mockResolvedValue(null);
		const thrown = await requireAuthBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/login");
	});

	it("ログイン済みならセッションをそのまま返す", async () => {
		const s = session();
		getSession.mockResolvedValue(s);
		await expect(requireAuthBeforeLoad()).resolves.toBe(s);
	});
});

// #259: 管理ガードの未ログイン判定を共通ガードへ委譲したので、両者の挙動が
// ドリフトしないことを固定する(#161/#177 で実際に起きたドリフトの再演防止)。
describe("requireAdminBeforeLoad", () => {
	beforeEach(() => {
		getSession.mockReset();
	});

	it("未ログインなら一般ルートと同じく /login へリダイレクトする", async () => {
		getSession.mockResolvedValue(null);
		const thrown = await requireAdminBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/login");
	});

	it("ログイン済みでも管理者でなければ / へ戻す", async () => {
		getSession.mockResolvedValue(session({ role: "user" }));
		const thrown = await requireAdminBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/");
	});

	it("BAN 中の管理者は / へ戻す", async () => {
		getSession.mockResolvedValue(session({ role: "admin", banned: true }));
		const thrown = await requireAdminBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/");
	});

	it("BAN されていない管理者は通す", async () => {
		getSession.mockResolvedValue(session({ role: "admin", banned: false }));
		await expect(requireAdminBeforeLoad()).resolves.toBeUndefined();
	});
});
