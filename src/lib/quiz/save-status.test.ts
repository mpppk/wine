import { describe, expect, it } from "vitest";
import { UNAUTHORIZED_MESSAGE, UnauthorizedError } from "#/lib/errors";
import { addSaveFailure, classifyQuizSaveFailure } from "./save-status";

describe("classifyQuizSaveFailure", () => {
	it("server fn 越しに平坦化された 401 を unauthorized と判定する", () => {
		// 実機で確認した形: クラス名も status も失われ、メッセージだけが残る。
		expect(classifyQuizSaveFailure(new Error(UNAUTHORIZED_MESSAGE))).toBe(
			"unauthorized",
		);
	});

	it("送出側の UnauthorizedError をそのまま渡しても unauthorized になる", () => {
		// MCP など同一プロセス内で受ける経路や、将来フレームワークが型を保つ場合。
		expect(classifyQuizSaveFailure(new UnauthorizedError())).toBe(
			"unauthorized",
		);
	});

	it("status/statusCode が 401 なら unauthorized と判定する", () => {
		expect(classifyQuizSaveFailure({ status: 401 })).toBe("unauthorized");
		expect(classifyQuizSaveFailure({ statusCode: 401 })).toBe("unauthorized");
	});

	it("それ以外の失敗は unknown", () => {
		expect(classifyQuizSaveFailure(new Error("boom"))).toBe("unknown");
		expect(classifyQuizSaveFailure({ status: 500 })).toBe("unknown");
		expect(classifyQuizSaveFailure(undefined)).toBe("unknown");
		expect(classifyQuizSaveFailure(null)).toBe("unknown");
		expect(classifyQuizSaveFailure("Unauthorized")).toBe("unknown");
	});
});

describe("addSaveFailure", () => {
	it("同じ種別の連続失敗を数える", () => {
		const first = addSaveFailure(null, new Error("boom"));
		expect(first).toEqual({ kind: "unknown", count: 1 });
		expect(addSaveFailure(first, new Error("boom"))).toEqual({
			kind: "unknown",
			count: 2,
		});
	});

	it("種別が変わったら数え直す(直近の原因を表示するため)", () => {
		const prev = { kind: "unknown", count: 3 } as const;
		expect(addSaveFailure(prev, new Error(UNAUTHORIZED_MESSAGE))).toEqual({
			kind: "unauthorized",
			count: 1,
		});
	});
});
