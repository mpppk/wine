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
