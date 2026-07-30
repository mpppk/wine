// BAN(利用停止)されたユーザからの MCP リクエストに返すレスポンス(#330)。
// ランタイム(D1 / cloudflare:workers)に依存しない純粋な組み立てだけを置き、
// jsdom 単体テストから検証できるようにする(BAN 判定自体は
// `#/lib/admin/moderation` の isBanActive、DB 参照は user-service)。

/** MCP クライアントに表示される停止時のメッセージ。 */
export const MCP_BANNED_MESSAGE =
	"このアカウントは利用停止中のため、MCP から操作できません。";

/**
 * 停止中ユーザへの 403 レスポンス。
 *
 * 401 + `WWW-Authenticate` にすると MCP クライアントは再認可を試みるが、BAN 中は
 * サインイン自体が拒否されるため再認可は成功しえない。「認証は有効だが操作を
 * 許可しない」= 403 を返し、本文は JSON-RPC のエラー応答にしてホスト側で理由が
 * 読める形にする(リクエスト id を復元せずに返すため id は null)。
 */
export function bannedResponse(): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32000, message: MCP_BANNED_MESSAGE },
			id: null,
		}),
		{ status: 403, headers: { "content-type": "application/json" } },
	);
}
