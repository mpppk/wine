// MCP Apps ホストの iframe に埋め込まれるビュー(/embed/*)の判定。
//
// これらのページは第三者オリジンの、しかもサンドボックス(allow-same-origin 無し)の
// iframe で描画される。文書のオリジンが不透明になるため、自オリジンへの fetch は
// CORS で必ず失敗する(Cookie も送られない)。したがって埋め込みビューでは
// 認証・課金に依存する UI を一切動かさない。判定を1箇所に集約して、アプリの
// 共通シェルへ新しいウィジェットを足したときの適用漏れを防ぐ。
export function isEmbedPath(pathname: string): boolean {
	return pathname === "/embed" || pathname.startsWith("/embed/");
}
