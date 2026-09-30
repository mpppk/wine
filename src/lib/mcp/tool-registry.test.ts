import { describe, expect, it } from "vitest";
import {
	capabilitiesForScopes,
	grantedMcpToolNames,
	isMcpWineScope,
	MCP_TOOL_CAPABILITIES,
	MCP_TOOL_NAMES,
	MCP_TOOL_SCOPES,
} from "./tool-registry";

// Issue #549。レジストリはツール登録・同意画面の表示・スコープ絞り込みの
// 単一情報源。ここが実態と乖離すると、利用者は実態より狭い権限だと誤解した
// まま承認することになる(#399 の対策が無効化される)。

describe("MCP_TOOL_NAMES", () => {
	// 件数だけでなく顔ぶれを固定する(#216 と同じ発想)。12個目のツールを足して
	// レジストリだけ更新し、同意画面の見直しを忘れる drift をここで落とす。
	// **このテストを更新するときは、対応する capabilityJa が利用者に誤解を
	// 与えない文言かも同時に確認する**。
	it("登録済みツール名一覧のスナップショット(増減時は必ず落ちる)", () => {
		expect([...MCP_TOOL_NAMES]).toEqual([
			"get_current_user",
			"ask_region",
			"list_wine_regions",
			"list_grape_varieties",
			"list_aops",
			"get_aop",
			"show_aop_map",
			"register_drunk_wine",
			"update_drunk_wine",
			"list_drunk_wines",
			"add_wine_tasting",
		]);
	});
});

describe("MCP_TOOL_CAPABILITIES", () => {
	it("重複が無く、空でない", () => {
		expect(MCP_TOOL_CAPABILITIES.length).toBeGreaterThan(0);
		expect(new Set(MCP_TOOL_CAPABILITIES).size).toBe(
			MCP_TOOL_CAPABILITIES.length,
		);
	});

	it("全ツールがいずれかの capability にぶら下がる", () => {
		// capabilityJa の付け忘れ(空文字等)は型では検出できないためここで見る。
		for (const capability of MCP_TOOL_CAPABILITIES) {
			expect(capability.length).toBeGreaterThan(0);
		}
	});
});

describe("MCP_TOOL_SCOPES", () => {
	it("全ツールに必要スコープが割り当てられている", () => {
		expect(Object.keys(MCP_TOOL_SCOPES).sort()).toEqual(
			[...MCP_TOOL_NAMES].sort(),
		);
	});

	it("AIクレジット消費は wine:ai、書き込みは wine:write に分離する", () => {
		expect(MCP_TOOL_SCOPES.ask_region).toBe("wine:ai");
		expect(MCP_TOOL_SCOPES.register_drunk_wine).toBe("wine:write");
		expect(MCP_TOOL_SCOPES.update_drunk_wine).toBe("wine:write");
		expect(MCP_TOOL_SCOPES.add_wine_tasting).toBe("wine:write");
		expect(MCP_TOOL_SCOPES.list_drunk_wines).toBe("wine:read");
	});
});

describe("grantedMcpToolNames", () => {
	it("スコープ未指定(undefined・空)は従来どおり全許可(既存トークン互換)", () => {
		expect(grantedMcpToolNames(undefined)).toEqual(MCP_TOOL_NAMES);
		expect(grantedMcpToolNames([])).toEqual(MCP_TOOL_NAMES);
	});

	it("既存の OIDC スコープだけでは絞り込まない", () => {
		expect(
			grantedMcpToolNames(["openid", "profile", "email", "offline_access"]),
		).toEqual(MCP_TOOL_NAMES);
	});

	it("wine:read だけでは書き込みとAI質問が出ない", () => {
		const names = grantedMcpToolNames(["openid", "wine:read"]);
		expect(names).toContain("list_aops");
		expect(names).toContain("list_drunk_wines");
		expect(names).not.toContain("register_drunk_wine");
		expect(names).not.toContain("update_drunk_wine");
		expect(names).not.toContain("add_wine_tasting");
		expect(names).not.toContain("ask_region");
	});

	it("wine:write + wine:ai の組み合わせは該当ツールだけになる", () => {
		expect([...grantedMcpToolNames(["wine:write", "wine:ai"])].sort()).toEqual(
			[
				"ask_region",
				"register_drunk_wine",
				"update_drunk_wine",
				"add_wine_tasting",
			].sort(),
		);
	});

	it("未知の wine: スコープは絞り込み側に倒す(fail-closed)", () => {
		// better-auth の認可時に未知スコープは invalid_scope で発行自体されないが、
		// 念のため未知の wine スコープだけでは何も許可しない。
		expect(isMcpWineScope("wine:delete")).toBe(false);
		expect(grantedMcpToolNames(["openid", "wine:delete"])).toEqual([]);
	});
});

describe("capabilitiesForScopes", () => {
	it("スコープ未指定は全件(従来の同意画面と同じ表示)", () => {
		expect(capabilitiesForScopes(undefined)).toEqual(MCP_TOOL_CAPABILITIES);
	});

	it("wine:read だけの要求には書き込み・AI課金の行を出さない", () => {
		const capabilities = capabilitiesForScopes(["wine:read"]);
		const all = capabilities.join("\n");
		expect(all).toContain("閲覧");
		expect(all).not.toContain("追加・更新");
		expect(all).not.toContain("AIクレジット");
	});

	it("wine:ai だけの要求にはAI課金の行だけを出す", () => {
		expect(capabilitiesForScopes(["wine:ai"])).toEqual([
			"AIへの質問の実行（あなたのAIクレジットを消費します）",
		]);
	});
});
