import { describe, expect, it } from "vitest";
import {
	describeOAuthScope,
	MCP_TOKEN_CAPABILITIES,
} from "./scope-description";

describe("describeOAuthScope (#399)", () => {
	it("既知のスコープは日本語の説明にする", () => {
		expect(describeOAuthScope("email")).toContain("メールアドレス");
		expect(describeOAuthScope("profile")).toContain("プロフィール");
		expect(describeOAuthScope("openid")).toContain("ユーザID");
	});

	// 「ログインしていない間もアクセスが続く」は同意の判断に直結するので、
	// 他のスコープと同じ粒度で流さず明示する。
	it("offline_access は継続アクセスであることを説明する", () => {
		expect(describeOAuthScope("offline_access")).toContain(
			"ログインしていない",
		);
	});

	// 未知のスコープを「その他の権限」等へ丸めると、見慣れない要求ほど
	// 目立たなくなる(同意フィッシングに有利に働く)。
	it("未知のスコープは丸めずそのまま出す", () => {
		expect(describeOAuthScope("admin:everything")).toBe("admin:everything");
		expect(describeOAuthScope("")).toBe("");
	});
});

describe("MCP_TOKEN_CAPABILITIES", () => {
	// スコープでツールを絞っていない以上、ここが利用者に示す唯一の権限範囲になる。
	// 実態より狭い記述だと、誤解したまま承認させることになる。
	it("メール読み取り・記録の書き込み・AIクレジット消費を明示する", () => {
		const all = MCP_TOKEN_CAPABILITIES.join("\n");
		expect(all).toContain("メールアドレス");
		expect(all).toContain("追加");
		expect(all).toContain("AIクレジット");
	});

	it("空でない", () => {
		expect(MCP_TOKEN_CAPABILITIES.length).toBeGreaterThan(0);
	});
});
