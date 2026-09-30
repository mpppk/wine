// MCPツール登録の唯一の情報源(SSOT)。Issue #549。
//
// 以前は `tools.ts` の `registerTool` 呼び出し(11個)と、同意画面の
// `MCP_TOKEN_CAPABILITIES`(手書き4行)が別々に管理され、ツールを足しても
// 同意画面もCIも何ひとつ変わらない状態だった(#399 の同意フィッシング対策を
// 無効化しかねないドリフト)。ここに `{ name, scope, capabilityJa }` を1行
// 足すことが、ツール登録・同意画面の表示・スナップショットテストのすべてに
// 反映される。
//
// 形は `src/lib/admin/audit.ts` の ADMIN_AUDIT_ACTIONS と同じ as-const パターン:
// as const の配列から union と対応表を導出し、網羅漏れを型で検出する。
// ブラウザ(同意画面)でも読むため、`cloudflare:workers` には依存しない
// (vitest の unit プロジェクト = jsdom でも import できる)。

/** MCP向けの権限スコープ。better-auth の mcp プラグイン(`oidcConfig.scopes`)に登録する。 */
const MCP_WINE_SCOPES = ["wine:read", "wine:write", "wine:ai"] as const;

export type McpWineScope = (typeof MCP_WINE_SCOPES)[number];

/** `MCP_WINE_SCOPES` の一覧。auth.ts の `oidcConfig.scopes` に渡す。 */
export const MCP_WINE_SCOPE_LIST: readonly McpWineScope[] = MCP_WINE_SCOPES;

/**
 * 全MCPツールの一覧。登録順(読み取り系→書き込み系)に並べる。
 *
 * - `name`: `server.registerTool` に渡すツール名。`tools.ts` の登録側は
 *   `McpToolName` 型で受けるため、ここに無い名前はコンパイルが通らない。
 * - `scope`: そのツールの使用に必要な wine スコープ。
 *   - `wine:read` … 読み取り(プロフィール・産地データ・マイセラーの閲覧)
 *   - `wine:write` … マイセラーへの記録の追加・更新
 *   - `wine:ai` … AIへの質問(クレジット消費あり)
 * - `capabilityJa`: 同意画面に出す「できること」1行。同じ文言のツールは
 *   まとめて1行になる(`MCP_TOOL_CAPABILITIES`)。
 *
 * **ツールを増減したらこの配列を更新する**。更新し忘れ・更新漏れは
 * `tool-registry.test.ts`(顔ぶれの固定)と `server.workers.test.ts` /
 * `tools.workers.test.ts`(登録実態との突き合わせ)が落とす。
 */
const MCP_TOOL_REGISTRY = [
	{
		name: "get_current_user",
		scope: "wine:read",
		capabilityJa: "プロフィール（表示名・メールアドレス）の読み取り",
	},
	{
		name: "ask_region",
		scope: "wine:ai",
		capabilityJa: "AIへの質問の実行（あなたのAIクレジットを消費します）",
	},
	{
		name: "list_wine_regions",
		scope: "wine:read",
		capabilityJa: "ワイン産地データ（地域・AOP・品種）の閲覧",
	},
	{
		name: "list_grape_varieties",
		scope: "wine:read",
		capabilityJa: "ワイン産地データ（地域・AOP・品種）の閲覧",
	},
	{
		name: "list_aops",
		scope: "wine:read",
		capabilityJa: "ワイン産地データ（地域・AOP・品種）の閲覧",
	},
	{
		name: "get_aop",
		scope: "wine:read",
		capabilityJa: "ワイン産地データ（地域・AOP・品種）の閲覧",
	},
	{
		name: "show_aop_map",
		scope: "wine:read",
		capabilityJa: "ワイン産地データ（地域・AOP・品種）の閲覧",
	},
	{
		name: "register_drunk_wine",
		scope: "wine:write",
		capabilityJa:
			"マイセラーへの記録の追加・更新（飲んだワイン・テイスティング）",
	},
	{
		name: "update_drunk_wine",
		scope: "wine:write",
		capabilityJa:
			"マイセラーへの記録の追加・更新（飲んだワイン・テイスティング）",
	},
	{
		name: "list_drunk_wines",
		scope: "wine:read",
		capabilityJa: "マイセラーの記録の閲覧",
	},
	{
		name: "add_wine_tasting",
		scope: "wine:write",
		capabilityJa:
			"マイセラーへの記録の追加・更新（飲んだワイン・テイスティング）",
	},
] as const;

export type McpToolName = (typeof MCP_TOOL_REGISTRY)[number]["name"];

/** 登録済みツール名の一覧(登録順)。スナップショットテストの期待値がここから出る。 */
export const MCP_TOOL_NAMES: readonly McpToolName[] = MCP_TOOL_REGISTRY.map(
	(t) => t.name,
);

/** ツール名 → 必要スコープ。`tools.ts` の登録ゲートが引く対応表。 */
export const MCP_TOOL_SCOPES: Record<McpToolName, McpWineScope> =
	Object.fromEntries(MCP_TOOL_REGISTRY.map((t) => [t.name, t.scope])) as Record<
		McpToolName,
		McpWineScope
	>;

/**
 * 同意画面に出す「できること」の一覧。レジストリの登場順に重複を除いたもの。
 * `scope-description.ts` の `MCP_TOKEN_CAPABILITIES` はこの別名で、同意画面の
 * import 先は変えない。
 */
export const MCP_TOOL_CAPABILITIES: readonly string[] = [
	...new Set(MCP_TOOL_REGISTRY.map((t) => t.capabilityJa)),
];

/** 既知の wine スコープか。 */
export function isMcpWineScope(scope: string): scope is McpWineScope {
	return (MCP_WINE_SCOPES as readonly string[]).includes(scope);
}

/**
 * トークンの付与スコープから、登録してよいツール名を返す。
 *
 * **既存トークン互換**: wine スコープを1つも含まないトークン(undefined・空・
 * `openid`/`profile`/`email`/`offline_access` のみ)は従来どおり全ツールを返す。
 * wine スコープは後付けの opt-in で、付けた場合だけ絞り込みが有効になる。
 * `wine:` で始まる未知のスコープは opt-in の意思表示とみなして絞り込み側に
 * 倒す(fail-closed。better-auth の認可時に未知スコープは `invalid_scope` で
 * 発行自体されないため、通常ここには来ない)。
 */
export function grantedMcpToolNames(
	scopes: readonly string[] | undefined,
): readonly McpToolName[] {
	if (
		!scopes ||
		!scopes.some((s) => isMcpWineScope(s) || s.startsWith("wine:"))
	) {
		return MCP_TOOL_NAMES;
	}
	const granted = new Set(scopes.filter(isMcpWineScope));
	return MCP_TOOL_REGISTRY.filter((t) => granted.has(t.scope)).map(
		(t) => t.name,
	);
}

/**
 * 要求/付与スコープに対応する「できること」の一覧(同意画面用)。
 * wine スコープを含まない要求には全件を返す(従来の表示と同じ)。
 */
export function capabilitiesForScopes(
	scopes: readonly string[] | undefined,
): readonly string[] {
	const names = new Set(grantedMcpToolNames(scopes));
	return MCP_TOOL_CAPABILITIES.filter((capability) =>
		MCP_TOOL_REGISTRY.some(
			(t) => t.capabilityJa === capability && names.has(t.name),
		),
	);
}
