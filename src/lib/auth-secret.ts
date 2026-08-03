// better-auth の署名鍵(BETTER_AUTH_SECRET)が安全に設定されているかの判定。純ロジックのみ。
//
// この鍵はセッションCookieの署名・OAuth の state/consent・MCP OAuth のトークン発行に使われる。
// 破られると「有効な署名を持つCookieを自作できる」= 任意セッションのなりすましに直結する。

/**
 * better-auth が `secret` 未設定時に黙ってフォールバックする既定値
 * (`better-auth/dist/utils/constants.mjs`)。**OSS に書かれた公開文字列であって
 * シークレットではない**ため、ここに書き写しても機密性は損なわれない。
 *
 * 誤って「それらしい文字列」として環境変数に設定されてしまう事故も検出したいので、
 * 未設定だけでなくこの値そのものも危険として扱う。
 */
export const BETTER_AUTH_DEFAULT_SECRET =
	"better-auth-secret-12345678901234567890";

/** 署名鍵の設定不備。安全なら null。 */
export type AuthSecretProblem = "missing" | "default";

/**
 * 署名鍵の設定不備を判定する。
 *
 * better-auth 自身にも「既定値のままなら起動を拒否する」ガードはあるが、
 * **その条件は `NODE_ENV === "production"`** で、workerd では `process.env.NODE_ENV` が
 * 設定されないため発火しない(Vite の静的置換も、better-auth 側が Proxy 経由の動的
 * プロパティアクセスで読むため効かない)。結果、シークレット未設定のまま公開到達可能な
 * 環境が起動し続けられる状態だった(#389。preview が実際にそうなっていた)。
 *
 * そのため「起動時に自分で確かめる」側に倒す。
 */
export function authSecretProblem(
	secret: string | undefined | null,
): AuthSecretProblem | null {
	if (!secret) return "missing";
	if (secret === BETTER_AUTH_DEFAULT_SECRET) return "default";
	return null;
}

/** 起動ログに出す説明文。対処コマンドまで含めて、ログ1行で完結させる。 */
export function authSecretProblemMessage(problem: AuthSecretProblem): string {
	const cause =
		problem === "missing"
			? "BETTER_AUTH_SECRET is not set, so better-auth falls back to its publicly known default secret"
			: "BETTER_AUTH_SECRET is set to better-auth's publicly known default value";
	return `${cause}; session cookies and OAuth/MCP tokens issued by this environment can be forged by anyone. Set it with \`npx wrangler secret put BETTER_AUTH_SECRET\` (production) or \`npx wrangler versions secret put BETTER_AUTH_SECRET --env preview\` (preview), or \`.dev.vars\` for local development.`;
}
