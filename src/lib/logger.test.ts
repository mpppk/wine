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
