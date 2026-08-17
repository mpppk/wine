import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withSpan } from "#/lib/observability/span";

// MCP ツールの実行にスパンを張る(Issue #504)。
//
// **登録の入口(`registerTool`)を包む**のが要点で、ハンドラ側に1つずつ書かない。
// ツールは現在12個あり、経路ごとに書く形にすると13個目を足す人が忘れる——MCP Appの
// フォーム仕様が5重実装になって `photo_urls` 対応が漏れた #185、構造化ログが新ドメイン群で
// 未適用だった #166 と同じ失敗の形になる。ここを通しておけば、後から足したツールにも
// 計装が自動で乗る。
//
// 自動計装の fetch ハンドラスパン(`POST /api/mcp`)だけでは、そのリクエストが
// `list_aops` なのか `register_drunk_wine` なのかが分からない。MCP は1エンドポイントに
// 全ツールが多重化されているため、**パスでは経路が識別できない**のがカスタムスパンを
// 張る理由。

/** この計装が必要とする McpServer の口だけを取り出した形(テストからスタブを渡せる)。 */
export type ToolRegistrar = Pick<McpServer, "registerTool">;

/**
 * 以後 `server.registerTool` で登録されるツールのハンドラを、スパンで囲んだものに
 * 差し替える。**ツールを登録する前に呼ぶこと**(後から呼んでも既存の登録は包まれない)。
 *
 * ハンドラの引数・戻り値・例外はすべて素通しする。ツールの結末(成功/失敗)を属性に
 * 載せないのは、MCP のハンドラが失敗を `isError: true` の戻り値で表す設計で、例外に
 * ならないため——結末は既に構造化ログ(`mcp tool failed` / `mcp tool rejected`)にあり、
 * 同じ判定をここに写すと2箇所に散る。
 */
export function traceToolCalls(server: ToolRegistrar): void {
	// `registerTool` はツールごとに引数と戻り値の型が変わる generic メソッドで、その型を
	// 保ったまま包む書き方が無い。**キャストは境界の2箇所だけ**に閉じ込め、その間は
	// 型の付いたコードにしてある。ここでするのは「ハンドラの呼び出しをスパンで囲む」
	// ことだけで、引数も戻り値も変換せずに素通しするため、型を落として復元しても実体と
	// 食い違わない(素通しであることは tool-tracing.workers.test.ts で固定している)。
	const register = server.registerTool.bind(server) as (
		name: string,
		config: unknown,
		handler: (...args: unknown[]) => unknown,
	) => unknown;
	server.registerTool = ((
		name: string,
		config: unknown,
		handler: (...args: unknown[]) => unknown,
	) =>
		register(name, config, (...args) =>
			withSpan("mcp_tool", { "wine.mcp.tool": name }, () => handler(...args)),
		)) as ToolRegistrar["registerTool"];
}
