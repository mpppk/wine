import { describe, expect, it } from "vitest";
import { MCP_TOOL_CAPABILITIES } from "#/lib/mcp/tool-registry";
import {
	capabilitiesForRequestScopes,
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
	// レジストリ(tool-registry.ts)からの導出であること。手書きに戻ると
	// ツール追加時のドリフト(#549)が再発するため、同一性をここで固定する。
	it("レジストリ由来の capability と一致する(手書きに戻さない)", () => {
		expect(MCP_TOKEN_CAPABILITIES).toEqual(MCP_TOOL_CAPABILITIES);
	});

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

describe("capabilitiesForRequestScopes", () => {
	it("wine スコープ無しの要求には全件を出す(既存トークンは全許可のため)", () => {
		expect(capabilitiesForRequestScopes([])).toEqual(MCP_TOKEN_CAPABILITIES);
		expect(capabilitiesForRequestScopes(["openid", "offline_access"])).toEqual(
			MCP_TOKEN_CAPABILITIES,
		);
	});

	it("wine:read のみの要求には書き込み・AI課金を出さない", () => {
		const capabilities = capabilitiesForRequestScopes(["wine:read"]).join("\n");
		expect(capabilities).not.toContain("追加・更新");
		expect(capabilities).not.toContain("AIクレジット");
	});
});

describe("describeOAuthScope の wine スコープ", () => {
	it("wine スコープは日本語の説明にする", () => {
		expect(describeOAuthScope("wine:read")).toContain("読み取りのみ");
		expect(describeOAuthScope("wine:write")).toContain("追加・更新");
		expect(describeOAuthScope("wine:ai")).toContain("AIクレジット");
	});
});
