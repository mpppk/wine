import { describe, expect, it } from "vitest";
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	HttpError,
	httpErrorStatus,
	isUnauthorizedError,
	NotFoundError,
	UnauthorizedError,
} from "./errors";

// server function の境界を越えると HttpError のプロトタイプが失われる(#255)。
// クライアントが実際に受け取る形(素の Error + name/status の own プロパティ)を
// 再現して、判定関数がそれを取りこぼさないことを固定する。
function asDeserialized(error: HttpError): Error {
	const plain = new Error(error.message);
	plain.name = error.name;
	Object.assign(plain, { status: error.status });
	return plain;
}

describe("errors", () => {
	it("各派生型は対応する status と name を持つ", () => {
		expect(new UnauthorizedError()).toMatchObject({
			status: 401,
			name: "UnauthorizedError",
		});
		expect(new ForbiddenError()).toMatchObject({
			status: 403,
			name: "ForbiddenError",
		});
		expect(new BadRequestError()).toMatchObject({
			status: 400,
			name: "BadRequestError",
		});
		expect(new NotFoundError()).toMatchObject({
			status: 404,
			name: "NotFoundError",
		});
		expect(new ConflictError()).toMatchObject({
			status: 409,
			name: "ConflictError",
		});
	});

	it("全派生型は HttpError かつ Error のインスタンス(境界での instanceof 判定に使える)", () => {
		for (const e of [
			new NotFoundError("no"),
			new ConflictError("dup"),
			new BadRequestError("bad"),
		]) {
			expect(e).toBeInstanceOf(HttpError);
			expect(e).toBeInstanceOf(Error);
		}
	});

	it("メッセージは指定でき、既定値も持つ", () => {
		expect(new NotFoundError("該当エントリがありません").message).toBe(
			"該当エントリがありません",
		);
		expect(new ConflictError().message).toBe("Conflict");
	});
});

describe("httpErrorStatus", () => {
	it("サーバ側の HttpError インスタンスからステータスを取る", () => {
		expect(httpErrorStatus(new UnauthorizedError())).toBe(401);
		expect(httpErrorStatus(new ConflictError())).toBe(409);
	});

	it("プロトタイプが失われた復元後のエラーからもステータスを取る", () => {
		expect(httpErrorStatus(asDeserialized(new UnauthorizedError()))).toBe(401);
		expect(httpErrorStatus(asDeserialized(new ConflictError()))).toBe(409);
	});

	it("HTTPステータスを持たない値は undefined", () => {
		expect(httpErrorStatus(new Error("boom"))).toBeUndefined();
		expect(httpErrorStatus(null)).toBeUndefined();
		expect(httpErrorStatus("401")).toBeUndefined();
		// status が数値でないものを拾わない(文字列比較に落ちると誤判定する)
		expect(httpErrorStatus({ status: "401" })).toBeUndefined();
	});
});

describe("isUnauthorizedError", () => {
	it("サーバ側インスタンス・復元後のどちらでも真", () => {
		expect(isUnauthorizedError(new UnauthorizedError())).toBe(true);
		expect(isUnauthorizedError(asDeserialized(new UnauthorizedError()))).toBe(
			true,
		);
	});

	it("status が落ちても name で判定できる", () => {
		const nameOnly = new Error("Unauthorized");
		nameOnly.name = "UnauthorizedError";
		expect(isUnauthorizedError(nameOnly)).toBe(true);
	});

	it("他の 4xx・素のエラーは偽", () => {
		expect(isUnauthorizedError(new ConflictError())).toBe(false);
		expect(isUnauthorizedError(asDeserialized(new ForbiddenError()))).toBe(
			false,
		);
		expect(isUnauthorizedError(new Error("boom"))).toBe(false);
		expect(isUnauthorizedError(undefined)).toBe(false);
	});
});
