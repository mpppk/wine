import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BadRequestError,
	ForbiddenError,
	NotFoundError,
	UnauthorizedError,
} from "#/lib/errors";

// server function 境界(middleware.ts)の写像を固定する。
//
// docs/architecture.md の「server fn のテストは書かない」は"薄い1行委譲"を前提にした方針で、
// このファイルはそれに当たらない。runWithHttpStatus は HttpError→4xx の写像と、想定外例外の
// 構造化ログという判断を持つ。ここが壊れると 4xx が再び 500 に混ざり(#153)、Workers Logs の
// 障害シグナルが希釈される(#156)。全 server function がこの1箇所を通るため、影響は全経路に及ぶ。
//
// TanStack Start の実体(@tanstack/react-start)は Start プラグイン前提で vitest からは
// 解決できない(vitest.config.ts のコメント参照)。フレームワーク側は境界のインターフェース
// (createMiddleware / getRequest / setResponseStatus)だけをモックし、middleware.ts 自身の
// ロジックを素の関数として呼ぶ。

/** テストごとに差し替えるフレームワーク境界の状態 */
const hooks = vi.hoisted(() => ({
	/** setResponseStatus に渡された値の記録 */
	statuses: [] as number[],
	/** getRequest が返すリクエスト */
	requestUrl: "https://wine.test/_serverFn/quiz.saveAnswer",
	/** auth.api.getSession の戻り値 */
	session: null as unknown,
}));

vi.mock("@tanstack/react-start", () => ({
	// createMiddleware({type}).server(fn) の fn をそのまま取り出す。
	createMiddleware: () => ({ server: (fn: unknown) => fn }),
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => new Request(hooks.requestUrl),
	setResponseStatus: (status: number) => {
		hooks.statuses.push(status);
	},
}));

// #/lib/auth は better-auth と cloudflare:workers を引き込むため、実体は読ませない。
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => hooks.session } },
}));

const { adminMiddleware, authMiddleware, optionalAuthMiddleware } =
	await import("./middleware");

/** middleware.ts が受け取る next の最小形 */
type Next = (opts?: { context?: unknown }) => Promise<unknown>;
type ServerFn = (args: { next: Next }) => Promise<unknown>;

const runAuth = authMiddleware as unknown as ServerFn;
const runAdmin = adminMiddleware as unknown as ServerFn;
const runOptional = optionalAuthMiddleware as unknown as ServerFn;

function sessionFor(
	user: { id: string; role?: string | null; banned?: boolean | null } = {
		id: "u1",
	},
) {
	return { user, session: { id: `sess_${user.id}` } };
}

/** ハンドラが例外を投げる next */
function throwingNext(e: unknown): Next {
	return () => Promise.reject(e);
}

beforeEach(() => {
	hooks.statuses = [];
	hooks.requestUrl = "https://wine.test/_serverFn/quiz.saveAnswer";
	hooks.session = null;
	vi.restoreAllMocks();
});

describe("authMiddleware", () => {
	it("未ログインは 401 を明示し UnauthorizedError を投げる", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const next = vi.fn();

		await expect(runAuth({ next })).rejects.toBeInstanceOf(UnauthorizedError);

		expect(hooks.statuses).toEqual([401]);
		// ハンドラは呼ばれない
		expect(next).not.toHaveBeenCalled();
		// 認証切れは正常系なので warn。error にすると障害シグナルを薄める(#255)
		expect(warn).toHaveBeenCalledTimes(1);
		const line = JSON.parse(warn.mock.calls[0][0] as string);
		expect(line).toMatchObject({
			level: "warn",
			msg: "server fn unauthorized",
			// 問い合わせの裏取りに使うので、どの server fn かが残ること
			path: "/_serverFn/quiz.saveAnswer",
		});
	});

	it("ログイン済みならユーザとセッションを context に注入して結果を返す", async () => {
		hooks.session = sessionFor({ id: "u1" });
		const next = vi.fn(async () => "handler-result");

		await expect(runAuth({ next })).resolves.toBe("handler-result");

		expect(next).toHaveBeenCalledWith({
			context: { user: { id: "u1" }, session: { id: "sess_u1" } },
		});
		// 正常系ではステータスを触らない(既定の 200 のまま)
		expect(hooks.statuses).toEqual([]);
	});

	it("ハンドラの HttpError は対応する 4xx へ写し、ログは出さない", async () => {
		hooks.session = sessionFor();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			runAuth({ next: throwingNext(new BadRequestError("bad input")) }),
		).rejects.toBeInstanceOf(BadRequestError);

		expect(hooks.statuses).toEqual([400]);
		// 想定内の 4xx を logError に出すと、Workers Logs 上で実際の障害が埋もれる
		expect(error).not.toHaveBeenCalled();
	});

	it.each([
		[new NotFoundError(), 404],
		[new ForbiddenError(), 403],
	])("HttpError のステータスをそのまま写す (%s)", async (thrown, expected) => {
		hooks.session = sessionFor();
		await expect(runAuth({ next: throwingNext(thrown) })).rejects.toBe(thrown);
		expect(hooks.statuses).toEqual([expected]);
	});

	it("想定外の例外は userId 付きで構造化ログに残し、ステータスは触らず再throwする", async () => {
		hooks.session = sessionFor({ id: "u42" });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const boom = new TypeError("undefined is not a function");

		await expect(runAuth({ next: throwingNext(boom) })).rejects.toBe(boom);

		// 5xx のまま(既定)にする。ここで 4xx を付けると障害が成功系に見える
		expect(hooks.statuses).toEqual([]);
		expect(error).toHaveBeenCalledTimes(1);
		const line = JSON.parse(error.mock.calls[0][0] as string);
		expect(line).toMatchObject({
			level: "error",
			msg: "server fn failed",
			// 呼び出し側に手を入れず追跡できることが要件(#156)
			userId: "u42",
			err: "TypeError: undefined is not a function",
		});
	});
});

describe("adminMiddleware", () => {
	it("管理者は通し、context にユーザとセッションを注入する", async () => {
		hooks.session = sessionFor({ id: "admin1", role: "admin", banned: false });
		const next = vi.fn(async () => "ok");

		await expect(runAdmin({ next })).resolves.toBe("ok");

		expect(next).toHaveBeenCalledWith({
			context: {
				user: { id: "admin1", role: "admin", banned: false },
				session: { id: "sess_admin1" },
			},
		});
		expect(hooks.statuses).toEqual([]);
	});

	it.each([
		["未ログイン", null],
		["一般ユーザ", sessionFor({ id: "u1", role: "user" })],
		["role 未設定", sessionFor({ id: "u2" })],
		// BAN された管理者を通すのが #161 で潰したドリフトそのもの
		["BAN 済みの管理者", sessionFor({ id: "a9", role: "admin", banned: true })],
	])("%s は 403 で拒否する", async (_label, session) => {
		hooks.session = session;
		const next = vi.fn();

		await expect(runAdmin({ next })).rejects.toBeInstanceOf(ForbiddenError);

		expect(hooks.statuses).toEqual([403]);
		expect(next).not.toHaveBeenCalled();
	});

	it("管理者ハンドラの HttpError も 4xx へ写す", async () => {
		hooks.session = sessionFor({ id: "admin1", role: "admin" });

		await expect(
			runAdmin({ next: throwingNext(new NotFoundError("no such user")) }),
		).rejects.toBeInstanceOf(NotFoundError);

		expect(hooks.statuses).toEqual([404]);
	});
});

describe("optionalAuthMiddleware", () => {
	it("未ログインでも通し、user: null を注入する", async () => {
		const next = vi.fn(async () => "public");

		await expect(runOptional({ next })).resolves.toBe("public");

		expect(next).toHaveBeenCalledWith({ context: { user: null } });
		expect(hooks.statuses).toEqual([]);
	});

	it("ログイン済みなら user を注入する", async () => {
		hooks.session = sessionFor({ id: "u7" });
		const next = vi.fn(async () => "private");

		await expect(runOptional({ next })).resolves.toBe("private");

		expect(next).toHaveBeenCalledWith({ context: { user: { id: "u7" } } });
	});

	it("未ログインでもハンドラの HttpError は 4xx へ写す", async () => {
		await expect(
			runOptional({ next: throwingNext(new BadRequestError("bad")) }),
		).rejects.toBeInstanceOf(BadRequestError);

		expect(hooks.statuses).toEqual([400]);
	});

	it("未ログインの想定外例外は userId なしで構造化ログに残す", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const boom = new Error("kaboom");

		await expect(runOptional({ next: throwingNext(boom) })).rejects.toBe(boom);

		const line = JSON.parse(error.mock.calls[0][0] as string);
		expect(line).toMatchObject({ level: "error", msg: "server fn failed" });
		expect(line.userId).toBeUndefined();
	});
});
