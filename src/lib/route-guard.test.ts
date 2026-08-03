import { beforeEach, describe, expect, it, vi } from "vitest";
import { toRouteSession } from "./route-session";

// server function は Cloudflare 依存を引き込むためモックする。生セッション →
// RouteSession の変換は本物(toRouteSession)を通し、role/banned から isAdmin が
// 算出される経路ごと検証する(モックで isAdmin を直接与えると #177 型のドリフトを
// 検出できなくなる)。
const rawSession = vi.fn();
vi.mock("#/server/auth", () => ({
	getRouteSession: async () => toRouteSession(await rawSession()),
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
	return {
		user: {
			id: "u1",
			name: "User 1",
			role: "user",
			banned: false,
			...overrides,
		},
	};
}

describe("requireAuthBeforeLoad", () => {
	beforeEach(() => {
		rawSession.mockReset();
	});

	it("未ログインなら /login へリダイレクトする", async () => {
		rawSession.mockResolvedValue(null);
		const thrown = await requireAuthBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/login");
	});

	it("ログイン済みなら route context 用の最小セッションを返す", async () => {
		rawSession.mockResolvedValue(session());
		await expect(requireAuthBeforeLoad()).resolves.toEqual({
			userId: "u1",
			userName: "User 1",
			isAdmin: false,
		});
	});

	// #388: beforeLoad の戻り値は SSR HTML へ dehydrate され、クライアント遷移でも
	// server function のレスポンスとしてブラウザに届く。生セッションを返す実装に
	// 戻したら、ここで落ちる。
	it("セッショントークン・IP・UA を route context に載せない(#388)", async () => {
		rawSession.mockResolvedValue({
			...session(),
			session: {
				token: "raw-session-token",
				ipAddress: "203.0.113.10",
				userAgent: "Mozilla/5.0",
			},
		});

		const ctx = await requireAuthBeforeLoad();

		expect(JSON.stringify(ctx)).not.toContain("raw-session-token");
		expect(JSON.stringify(ctx)).not.toContain("203.0.113.10");
		expect(JSON.stringify(ctx)).not.toContain("Mozilla/5.0");
	});
});

// #259: 管理ガードの未ログイン判定を共通ガードへ委譲したので、両者の挙動が
// ドリフトしないことを固定する(#161/#177 で実際に起きたドリフトの再演防止)。
describe("requireAdminBeforeLoad", () => {
	beforeEach(() => {
		rawSession.mockReset();
	});

	it("未ログインなら一般ルートと同じく /login へリダイレクトする", async () => {
		rawSession.mockResolvedValue(null);
		const thrown = await requireAdminBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/login");
	});

	it("ログイン済みでも管理者でなければ / へ戻す", async () => {
		rawSession.mockResolvedValue(session({ role: "user" }));
		const thrown = await requireAdminBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/");
	});

	it("BAN 中の管理者は / へ戻す", async () => {
		rawSession.mockResolvedValue(session({ role: "admin", banned: true }));
		const thrown = await requireAdminBeforeLoad().catch((e) => e);
		expect(redirectTarget(thrown)).toBe("/");
	});

	it("BAN されていない管理者は通す", async () => {
		rawSession.mockResolvedValue(session({ role: "admin", banned: false }));
		await expect(requireAdminBeforeLoad()).resolves.toBeUndefined();
	});

	// 管理ルートの context にも role/banned そのものは出さない。
	it("管理者でも role / banned を route context に載せない", async () => {
		rawSession.mockResolvedValue(session({ role: "admin", banned: false }));
		const ctx = await requireAuthBeforeLoad();
		expect(Object.keys(ctx).sort()).toEqual(["isAdmin", "userId", "userName"]);
	});
});
