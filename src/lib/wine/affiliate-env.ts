import { env } from "cloudflare:workers";
import type { AffiliateConfig } from "./affiliate";

// アフィリエイト設定をランタイム環境変数から組み立てる唯一の入口(#340)。
//
// affiliate.ts 本体はクライアント(AopDetailPanel)からも読み込まれるため env を参照できない。
// 「env → AffiliateConfig」の変換だけをこの隣接モジュールに切り出し、Web の server fn
// (server/affiliate.ts)と MCP ツール(lib/mcp/tools.ts)の双方がここを通す。
//
// 経路ごとに `env.X ?? ""` を書くと、IDを1つ足したときに片方を直し忘れて、Web か MCP の
// 購入リンクだけが静かに欠落する(型では捕まらない)。

/**
 * 現在の環境のアフィリエイト設定を返す。未設定なら空文字(素の検索URLとして機能する)。
 *
 * 関数にして env の評価を呼び出し時まで遅延させる(モジュール import 時点で
 * `cloudflare:workers` の env を評価すると、テスト等での import 自体が難しくなる)。
 */
export function buildAffiliateConfig(): AffiliateConfig {
	return {
		rakuten: env.RAKUTEN_AFFILIATE_ID ?? "",
		moshimoAmazon: env.MOSHIMO_AMAZON_A_ID ?? "",
	};
}
