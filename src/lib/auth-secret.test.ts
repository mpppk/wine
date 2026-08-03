import { describe, expect, it } from "vitest";
import {
	authSecretProblem,
	authSecretProblemMessage,
	BETTER_AUTH_DEFAULT_SECRET,
} from "./auth-secret";

describe("authSecretProblem (#389)", () => {
	it("未設定は missing", () => {
		expect(authSecretProblem(undefined)).toBe("missing");
		expect(authSecretProblem(null)).toBe("missing");
		expect(authSecretProblem("")).toBe("missing");
	});

	// better-auth の既定値は OSS に書かれた公開文字列。「設定されている」ように見えて
	// 署名を誰でも自作できるので、未設定と同じく危険として扱う。
	it("better-auth の公開既定値は default", () => {
		expect(authSecretProblem(BETTER_AUTH_DEFAULT_SECRET)).toBe("default");
	});

	it("独自の値なら問題なし", () => {
		expect(authSecretProblem("0Zk9vQ2m4Xr7Lp1TgYbN8sWcJdHfAeUi")).toBeNull();
	});

	// 既定値の綴りが better-auth 側で変わると検出できなくなるため、実物と一致することを
	// 固定する(バンドル済みの実装を直接読む)。
	it("公開既定値の文字列が better-auth の実装と一致する", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			"node_modules/better-auth/dist/utils/constants.mjs",
			"utf8",
		);
		expect(source).toContain(BETTER_AUTH_DEFAULT_SECRET);
	});
});

describe("authSecretProblemMessage", () => {
	it("原因と対処コマンドをログ1行に含める", () => {
		for (const problem of ["missing", "default"] as const) {
			const msg = authSecretProblemMessage(problem);
			expect(msg).toContain("BETTER_AUTH_SECRET");
			expect(msg).toContain("wrangler secret put");
			// preview は versions 系コマンドでないと投入できない(docs/deployment.md)
			expect(msg).toContain("versions secret put");
			expect(msg).toContain("--env preview");
		}
	});

	it("未設定と既定値で原因の説明を書き分ける", () => {
		expect(authSecretProblemMessage("missing")).toContain("is not set");
		expect(authSecretProblemMessage("default")).toContain("default value");
	});
});
