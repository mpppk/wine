import { describe, expect, it } from "vitest";
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	HttpError,
	NotFoundError,
	UnauthorizedError,
} from "./errors";

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
