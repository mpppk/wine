import { afterEach, describe, expect, it, vi } from "vitest";
import { errToString, logError, logInfo, logWarn } from "./logger";

describe("logger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logError は level=error の1行JSONを console.error に出す", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		logError("upload failed", { userId: "u1", op: "avatar.put" });
		expect(spy).toHaveBeenCalledTimes(1);
		const line = spy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toEqual({
			level: "error",
			msg: "upload failed",
			userId: "u1",
			op: "avatar.put",
		});
	});

	it("logWarn / logInfo は対応する console メソッドに出す", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		logWarn("slow", { ms: 1200 });
		logInfo("ok", {});
		expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
			level: "warn",
			msg: "slow",
			ms: 1200,
		});
		expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toMatchObject({
			level: "info",
			msg: "ok",
		});
	});

	it("Error 値は名前+メッセージへ畳んで直列化する(生スタックは出さない)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		logError("boom", { err: new TypeError("bad input") });
		const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
		expect(parsed.err).toBe("TypeError: bad input");
	});

	it("errToString は Error 以外もそのまま文字列化する", () => {
		expect(errToString(new Error("x"))).toBe("x");
		expect(errToString(new RangeError("y"))).toBe("RangeError: y");
		expect(errToString("plain")).toBe("plain");
		expect(errToString(42)).toBe("42");
	});
});

// #331: JSON.stringify は Error の message/stack が非 enumerable なので {} に潰す。
// フィールド直下しか変換していなかった頃は、better-auth のロガーブリッジのように
// 可変長 args を配列で渡す経路(サインイン / OAuth / MCP OAuth)の真因が丸ごと消えていた。
describe("ネストした Error の直列化 (#331)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function loggedLine(fields: Record<string, unknown>) {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		logError("boom", fields);
		return JSON.parse(spy.mock.calls[0]?.[0] as string);
	}

	it("配列内の Error を文字列化する(better-auth ブリッジの args 形式)", () => {
		const parsed = loggedLine({ args: [new TypeError("bad input")] });
		expect(parsed.args).toEqual(["TypeError: bad input"]);
	});

	it("オブジェクト内・入れ子の Error も文字列化する", () => {
		const parsed = loggedLine({
			ctx: { inner: new Error("deep"), list: [{ e: new RangeError("r") }] },
		});
		expect(parsed.ctx.inner).toBe("deep");
		expect(parsed.ctx.list[0].e).toBe("RangeError: r");
	});

	it("ネストした Error でも cause を連結する", () => {
		const err = new Error("outer", { cause: new Error("root") });
		expect(loggedLine({ args: [err] }).args[0]).toBe("outer <- root");
	});

	it("Date は ISO 文字列のまま(作り直して {} に落とさない)", () => {
		const parsed = loggedLine({ at: new Date("2026-07-30T00:00:00.000Z") });
		expect(parsed.at).toBe("2026-07-30T00:00:00.000Z");
	});

	it("循環参照があってもログ呼び出しは例外にならない", () => {
		const a: Record<string, unknown> = { name: "a" };
		a.self = a;
		const parsed = loggedLine({ ctx: a });
		expect(parsed.ctx.name).toBe("a");
		expect(parsed.ctx.self).toBe("[circular]");
	});

	it("同じオブジェクトが兄弟で現れるのは循環扱いしない", () => {
		const shared = { id: 1 };
		const parsed = loggedLine({ ctx: { a: shared, b: shared } });
		expect(parsed.ctx.a).toEqual({ id: 1 });
		expect(parsed.ctx.b).toEqual({ id: 1 });
	});

	it("深すぎる入れ子は打ち切る(上限までは残す)", () => {
		const parsed = loggedLine({ a: { b: { c: { d: { e: { f: 1 } } } } } });
		expect(parsed.a.b.c.d).toEqual({ e: "[truncated]" });
	});

	// ログはリクエスト処理の失敗パスから呼ばれる。ここで throw すると元の失敗を
	// 覆い隠す新たな例外に化ける。
	it("直列化できない値でも throw せず、msg は必ず出す", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => logError("boom", { big: 1n })).not.toThrow();
		const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
		expect(parsed.msg).toBe("boom");
		expect(parsed.level).toBe("error");
		expect(typeof parsed.logSerializationError).toBe("string");
	});
});

// ラップした例外は外側が「何に失敗したか」、cause が「なぜ失敗したか」を持つ。
// cause を落とすと真因が消え、ai-service が全滅時の追跡用に積んでいる情報(#156)が
// ログから消える(#271)。
describe("errToString の cause 連結 (#271)", () => {
	it("cause を ` <- ` で連結する", () => {
		const err = new Error("すべての写真の解析に失敗しました", {
			cause: new TypeError("Unexpected token < in JSON"),
		});
		expect(errToString(err)).toBe(
			"すべての写真の解析に失敗しました <- TypeError: Unexpected token < in JSON",
		);
	});

	it("cause が Error 以外でも連結する", () => {
		expect(errToString(new Error("wrap", { cause: "raw string" }))).toBe(
			"wrap <- raw string",
		);
	});

	it("cause が無ければ従来どおり単体の文字列", () => {
		expect(errToString(new Error("solo"))).toBe("solo");
	});

	it("上限ちょうどの連鎖は省略記号を付けずに全部出す", () => {
		const chain = new Error("l0", {
			cause: new Error("l1", {
				cause: new Error("l2", { cause: new Error("l3") }),
			}),
		});
		expect(errToString(chain)).toBe("l0 <- l1 <- l2 <- l3");
	});

	it("上限を超える連鎖は打ち切って省略記号を付ける", () => {
		const deep = new Error("l0", {
			cause: new Error("l1", {
				cause: new Error("l2", {
					cause: new Error("l3", { cause: new Error("l4") }),
				}),
			}),
		});
		const out = errToString(deep);
		expect(out).toBe("l0 <- l1 <- l2 <- l3 <- …");
		// 上限を超えたぶんは出さない(ログ行の肥大化を防ぐ)
		expect(out).not.toContain("l4");
	});

	it("cause が循環していても止まる", () => {
		const a = new Error("a");
		(a as { cause?: unknown }).cause = a;
		expect(errToString(a)).toBe("a");
	});

	it("logError 経由でも cause がログ行に載る", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		logError("label analysis failed", {
			err: new Error("すべての写真の解析に失敗しました", {
				cause: new Error("AI model error"),
			}),
		});
		const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
		expect(parsed.err).toBe(
			"すべての写真の解析に失敗しました <- AI model error",
		);
	});
});
