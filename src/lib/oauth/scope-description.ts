// 同意画面(/oauth/consent)に出す説明文(#399)。純ロジックなので jsdom 単体テスト対象。

/**
 * **発行されたトークンで実際にできること**。
 *
 * 要求スコープ(openid / profile / email / offline_access)を並べるだけでは
 * 判断材料にならない。このアプリの MCP は **スコープでツールを絞っていない**
 * (`/api/mcp` にも `src/lib/mcp/tools.ts` にもスコープによる分岐が無く、
 * トークンが発行された時点で全11ツールが使える)。したがって同意画面は
 * 「どのスコープを要求されたか」ではなく「何ができるようになるか」を先に出す。
 *
 * **ツールを増やしたらここも増やす**。ここが実態と乖離すると、利用者は
 * 実際より狭い権限だと誤解して承認することになる。
 */
export const MCP_TOKEN_CAPABILITIES: readonly string[] = [
	"プロフィール（表示名・メールアドレス）の読み取り",
	"マイセラーの記録の閲覧",
	"マイセラーへの記録の追加・更新（飲んだワイン・テイスティング）",
	"AIへの質問の実行（あなたのAIクレジットを消費します）",
];

/** 既知スコープの説明。ここに無いものは生の値をそのまま出す。 */
const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	openid: "あなたが誰であるか（ユーザID）の確認",
	profile: "プロフィール情報（表示名など）の読み取り",
	email: "メールアドレスの読み取り",
	offline_access:
		"あなたがログインしていない間もアクセスを継続（リフレッシュトークンの発行）",
};

/**
 * スコープ名を日本語の説明に変換する。未知のスコープは**そのまま返す**
 * (勝手に「その他の権限」等へ丸めると、見慣れない要求を利用者が見落とす)。
 */
export function describeOAuthScope(scope: string): string {
	return SCOPE_DESCRIPTIONS[scope] ?? scope;
}
