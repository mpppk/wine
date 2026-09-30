// 同意画面(/oauth/consent)に出す説明文(#399)。純ロジックなので jsdom 単体テスト対象。
import {
	capabilitiesForScopes,
	MCP_TOOL_CAPABILITIES,
} from "#/lib/mcp/tool-registry";

/**
 * **発行されたトークンで実際にできること**。
 *
 * 中身は `src/lib/mcp/tool-registry.ts` の SSOT から導出する。以前は手書きの
 * 4行で、ツールを増やしたときにここだけ置いていかれるドリフトがあった(#549)。
 * ツールを増減したらレジストリを更新し、この一覧が追随することを
 * `tool-registry.test.ts` と `server.workers.test.ts` が固定する。
 */
export const MCP_TOKEN_CAPABILITIES: readonly string[] = MCP_TOOL_CAPABILITIES;

/**
 * 要求スコープに対応する「できること」の一覧(同意画面用)。wine スコープを
 * 含まない要求には `MCP_TOKEN_CAPABILITIES` 全件を返す(既存トークン互換:
 * スコープ未指定=従来どおり全許可のため、表示も従来どおり全件)。
 */
export function capabilitiesForRequestScopes(
	scopes: readonly string[] | undefined,
): readonly string[] {
	return capabilitiesForScopes(scopes);
}

/** 既知スコープの説明。ここに無いものは生の値をそのまま出す。 */
const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	openid: "あなたが誰であるか（ユーザID）の確認",
	profile: "プロフィール情報（表示名など）の読み取り",
	email: "メールアドレスの読み取り",
	offline_access:
		"あなたがログインしていない間もアクセスを継続（リフレッシュトークンの発行）",
	"wine:read":
		"読み取りのみ（プロフィール・産地データ・マイセラーの閲覧）。書き込みとAI質問はできません",
	"wine:write":
		"マイセラーへの記録の追加・更新（飲んだワイン・テイスティング）",
	"wine:ai": "AIへの質問の実行（あなたのAIクレジットを消費します）",
};

/**
 * スコープ名を日本語の説明に変換する。未知のスコープは**そのまま返す**
 * (勝手に「その他の権限」等へ丸めると、見慣れない要求を利用者が見落とす)。
 */
export function describeOAuthScope(scope: string): string {
	return SCOPE_DESCRIPTIONS[scope] ?? scope;
}
