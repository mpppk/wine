import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPERSONATION_READONLY_MESSAGE } from "#/lib/admin/impersonation";
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
	/** getRequest が返すリクエストのメソッド(なりすまし時の書き込み判定に使う) */
	requestMethod: "POST",
	/** auth.api.getSession の戻り値 */
	session: null as unknown,
	/** withinRateLimit が返す判定(false = 上限超過) */
	rateLimitAllows: true,
	/** withinRateLimit の呼び出し記録(用途とキー) */
	rateLimitCalls: [] as Array<{ name: string; key: string }>,
}));

vi.mock("@tanstack/react-start", () => ({
	// createMiddleware({type}).server(fn) の fn をそのまま取り出す。
	createMiddleware: () => ({ server: (fn: unknown) => fn }),
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () =>
		new Request(hooks.requestUrl, { method: hooks.requestMethod }),
	setResponseStatus: (status: number) => {
		hooks.statuses.push(status);
	},
}));

// #/lib/auth は better-auth と cloudflare:workers を引き込むため、実体は読ませない。
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => hooks.session } },
}));

// #/lib/rate-limit も cloudflare:workers(バインディング)を引き込む。実際の判定は
// 実 workerd 側(rate-limit.workers.test.ts)で見ているので、ここでは
// 「どの用途を・どのキーで引いたか」と「false のときの写像」だけを見る。
vi.mock("#/lib/rate-limit", () => ({
	withinRateLimit: (name: string, key: string) => {
		hooks.rateLimitCalls.push({ name, key });
		return Promise.resolve(hooks.rateLimitAllows);
	},
}));

const {
	adminMiddleware,
	authMiddleware,
	impersonationMiddleware,
	optionalAuthMiddleware,
} = await import("./middleware");

/** middleware.ts が受け取る next の最小形 */
type Next = (opts?: { context?: unknown }) => Promise<unknown>;
type ServerFn = (args: { next: Next }) => Promise<unknown>;

const runAuth = authMiddleware as unknown as ServerFn;
const runAdmin = adminMiddleware as unknown as ServerFn;
const runOptional = optionalAuthMiddleware as unknown as ServerFn;
const runImpersonation = impersonationMiddleware as unknown as ServerFn;

function sessionFor(
	user: { id: string; role?: string | null; banned?: boolean | null } = {
		id: "u1",
	},
) {
	return { user, session: { id: `sess_${user.id}` } };
}

/** なりすまし中(session.impersonatedBy に操作元 admin の id が入る)のセッション */
function impersonatedSessionFor(
	user: { id: string; role?: string | null; banned?: boolean | null } = {
		id: "u1",
	},
	impersonatedBy = "admin1",
) {
	return { user, session: { id: `sess_${user.id}`, impersonatedBy } };
}

/** ハンドラが例外を投げる next */
function throwingNext(e: unknown): Next {
	return () => Promise.reject(e);
}

/** console スパイが受けた最初の1行を構造化ログとして読む */
function loggedLine(spy: MockInstance): Record<string, unknown> {
	const call = spy.mock.calls[0];
	expect(call).toBeDefined();
	return JSON.parse(String(call?.[0]));
}

beforeEach(() => {
	hooks.statuses = [];
	hooks.requestUrl = "https://wine.test/_serverFn/quiz.saveAnswer";
	hooks.requestMethod = "POST";
	hooks.session = null;
	hooks.rateLimitAllows = true;
	hooks.rateLimitCalls = [];
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
		const line = loggedLine(warn);
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
		const line = loggedLine(error);
		expect(line).toMatchObject({
			level: "error",
			msg: "server fn failed",
			// 呼び出し側に手を入れず追跡できることが要件(#156)
			userId: "u42",
			err: "TypeError: undefined is not a function",
			// path が無いと、複数機能が同時に落ちたとき同一文言の行が並ぶだけになり
			// `bun run logs --level error` から障害箇所を切り分けられない(#332)
			path: "/_serverFn/quiz.saveAnswer",
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

		const line = loggedLine(error);
		expect(line).toMatchObject({ level: "error", msg: "server fn failed" });
		expect(line.userId).toBeUndefined();
		// 未ログインでも「どの機能が落ちたか」は残す(#332)
		expect(line.path).toBe("/_serverFn/quiz.saveAnswer");
	});
});

// #332: 「server fn failed」は文言が同一なので、path が無いと D1 障害などで複数機能が
// 同時に落ちたときに `bun run logs --level error` から障害箇所を切り分けられない。
// 4つのミドルウェア全部に付いていることを固定する(1つ足し忘れるとその経路だけ盲点になる)。
describe("失敗ログの path (#332)", () => {
	const cases: [string, ServerFn, () => void][] = [
		[
			"authMiddleware",
			runAuth,
			() => {
				hooks.session = sessionFor({ id: "u1" });
			},
		],
		[
			"adminMiddleware",
			runAdmin,
			() => {
				hooks.session = sessionFor({
					id: "admin1",
					role: "admin",
					banned: false,
				});
			},
		],
		[
			"optionalAuthMiddleware",
			runOptional,
			() => {
				hooks.session = sessionFor({ id: "u1" });
			},
		],
		[
			"impersonationMiddleware",
			runImpersonation,
			() => {
				hooks.session = impersonatedSessionFor({ id: "u1" });
			},
		],
	];

	it.each(cases)(
		"%s の想定外例外は path 付きで記録する",
		async (_label, run, setup) => {
			setup();
			hooks.requestUrl = "https://wine.test/_serverFn/cellar.updateEntry";
			hooks.requestMethod = "GET"; // なりすましの書き込みガードに引っ掛けない
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			const boom = new Error("kaboom");
			await expect(run({ next: throwingNext(boom) })).rejects.toBe(boom);

			expect(loggedLine(error)).toMatchObject({
				msg: "server fn failed",
				path: "/_serverFn/cellar.updateEntry",
			});
		},
	);
});

// なりすまし(impersonation)中の書き込み禁止(#116)。
//
// なりすまし中の書き込みは対象ユーザ本人の実データ(クイズ成績・セラー・AIクレジット)に
// 落ち、後から本人の操作と切り分けられない。全 server function がこの3ミドルウェアの
// どれかを通るため、ここが素通りすると経路単位で漏れる。
describe("なりすまし中の書き込みガード", () => {
	const runners: [string, ServerFn][] = [
		["authMiddleware", runAuth],
		["adminMiddleware", runAdmin],
		["optionalAuthMiddleware", runOptional],
	];

	it.each(runners)("%s は書き込み(POST)を 403 で拒否する", async (_l, run) => {
		// adminMiddleware も通るよう role=admin にしておく(拒否理由がなりすましだと分かる)
		hooks.session = impersonatedSessionFor({ id: "u1", role: "admin" });
		hooks.requestMethod = "POST";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const next = vi.fn();

		await expect(run({ next })).rejects.toBeInstanceOf(ForbiddenError);

		expect(hooks.statuses).toEqual([403]);
		expect(next).not.toHaveBeenCalled();
		// 管理者の誤操作を後から追えること
		expect(loggedLine(warn)).toMatchObject({
			level: "warn",
			msg: "impersonated write blocked",
			userId: "u1",
			path: "/_serverFn/quiz.saveAnswer",
		});
	});

	it.each(runners)("%s は閲覧(GET)を通す", async (_l, run) => {
		hooks.session = impersonatedSessionFor({ id: "u1", role: "admin" });
		hooks.requestMethod = "GET";
		const next = vi.fn(async () => "ok");

		await expect(run({ next })).resolves.toBe("ok");

		expect(hooks.statuses).toEqual([]);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it.each(runners)(
		"%s は通常セッションの書き込みを通す(ガードの巻き添えが無い)",
		async (_l, run) => {
			hooks.session = sessionFor({ id: "u1", role: "admin" });
			hooks.requestMethod = "POST";
			const next = vi.fn(async () => "ok");

			await expect(run({ next })).resolves.toBe("ok");

			expect(hooks.statuses).toEqual([]);
		},
	);

	it("403 のメッセージは共通定数(UIと同じ文言)を使う", async () => {
		hooks.session = impersonatedSessionFor();
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(runAuth({ next: vi.fn() })).rejects.toThrow(
			IMPERSONATION_READONLY_MESSAGE,
		);
	});

	it("未ログインの POST はなりすまし判定に巻き込まれず 401 のまま", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(runAuth({ next: vi.fn() })).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
		expect(hooks.statuses).toEqual([401]);
	});
});

// なりすましの「終了」だけは、なりすまし中(=閲覧専用)のセッションから実行できないと
// 管理者が戻れなくなる。書き込みガードを通らない唯一の経路なので、逆に「なりすまし中
// でなければ通さない」ことを固定する。
describe("impersonationMiddleware", () => {
	it("なりすまし中なら POST でも通し、context に user/session を注入する", async () => {
		hooks.session = impersonatedSessionFor({ id: "u1" }, "admin9");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const next = vi.fn(async () => "stopped");

		await expect(runImpersonation({ next })).resolves.toBe("stopped");

		expect(next).toHaveBeenCalledWith({
			context: {
				user: { id: "u1" },
				session: { id: "sess_u1", impersonatedBy: "admin9" },
			},
		});
		expect(hooks.statuses).toEqual([]);
	});

	it("未ログインは 401", async () => {
		await expect(runImpersonation({ next: vi.fn() })).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
		expect(hooks.statuses).toEqual([401]);
	});

	it("通常セッション(なりすまし中でない)は 400 で拒否する", async () => {
		hooks.session = sessionFor({ id: "u1" });
		const next = vi.fn();

		await expect(runImpersonation({ next })).rejects.toBeInstanceOf(
			BadRequestError,
		);

		expect(hooks.statuses).toEqual([400]);
		expect(next).not.toHaveBeenCalled();
	});
});

// #397: サインアップは開放されているので、1アカウントから書き込みを積み上げるだけで
// R2/D1 の従量コストを増やせた。server function の入口はこの1箇所なので、ここで絞れば
// 後から足す機能も自動的に守られる。
describe("書き込みのレートリミット (#397)", () => {
	it("書き込み(POST)は write 用途・userId をキーに判定する", async () => {
		hooks.session = sessionFor({ id: "u1" });
		hooks.requestMethod = "POST";

		await runAuth({ next: vi.fn().mockResolvedValue("ok") });

		expect(hooks.rateLimitCalls).toEqual([{ name: "write", key: "u1" }]);
	});

	// 1画面が複数の server function を並行に呼ぶため、読み取りまで数えると
	// 通常利用が先に上限へ当たる。#397 の脅威はすべて書き込み側にある。
	it("読み取り(GET)は判定そのものを行わない", async () => {
		hooks.session = sessionFor({ id: "u1" });
		hooks.requestMethod = "GET";

		await runAuth({ next: vi.fn().mockResolvedValue("ok") });

		expect(hooks.rateLimitCalls).toEqual([]);
	});

	it("上限超過は 429 で、ハンドラを実行しない", async () => {
		hooks.session = sessionFor({ id: "u1" });
		hooks.requestMethod = "POST";
		hooks.rateLimitAllows = false;
		const next = vi.fn();

		const thrown = await runAuth({ next }).catch((e) => e);

		expect((thrown as { status?: number }).status).toBe(429);
		expect(hooks.statuses).toEqual([429]);
		// 書き込みが起きないことが要点(429 を返すだけでは意味がない)。
		expect(next).not.toHaveBeenCalled();
	});

	// 管理者は isAdminSession で絞り込まれた信頼済みの主体で、一括クレジット補填など
	// 短時間に多くの書き込みを出す正当な用途がある。#397 の脅威モデルの外。
	it("管理ルートは絞らない", async () => {
		hooks.session = sessionFor({ id: "admin1", role: "admin" });
		hooks.requestMethod = "POST";
		hooks.rateLimitAllows = false;
		const next = vi.fn().mockResolvedValue("ok");

		await expect(runAdmin({ next })).resolves.toBe("ok");
		expect(hooks.rateLimitCalls).toEqual([]);
	});

	// なりすましガードが先に立つ。順序が入れ替わると、なりすまし中の書き込みが
	// 「上限内なら通る」ように見えてしまう。
	it("なりすまし中の書き込みはレートリミット判定より前に 403 で止まる", async () => {
		hooks.session = impersonatedSessionFor({ id: "u1" });
		hooks.requestMethod = "POST";

		await expect(runAuth({ next: vi.fn() })).rejects.toBeInstanceOf(
			ForbiddenError,
		);
		expect(hooks.rateLimitCalls).toEqual([]);
	});
});
