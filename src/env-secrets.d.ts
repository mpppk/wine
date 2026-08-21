// `wrangler secret put` / `.dev.vars` で渡すシークレットの型宣言。**シークレットの
// 宣言はこのファイルだけに置く**(#261)。
//
// `wrangler types` は wrangler.jsonc の vars に加えて **ローカルの .dev.vars も型に
// 取り込む**ため、素で実行すると開発者の手元の設定次第で worker-configuration.d.ts に
// シークレットが必須 string として焼き込まれ、ここでのオプショナル宣言と衝突する
// (skipLibCheck で黙殺される)。生成結果が環境依存で揺れると、
// `if (!env.STRIPE_WEBHOOK_SECRET)` のような未設定チェックが「型上は常に truthy」に
// 見える環境と見えない環境が併存し、防御コードの要否判断を誤る。
//
// そのため package.json の cf-typegen は `--env-file=/dev/null` で .dev.vars を
// 読ませない。シークレットは必ず未設定でありうるので、ここでは全て optional にする。
declare namespace Cloudflare {
	interface Env {
		// better-auth のセッションCookie署名・OAuthトークン生成に使う必須シークレット。
		// 本番は `wrangler secret put BETTER_AUTH_SECRET`、プレビューは
		// `wrangler versions secret put BETTER_AUTH_SECRET --env preview`、ローカルは
		// `.dev.vars` で設定する。
		//
		// **未設定でも起動してしまう**(better-auth が公開の既定値へ黙ってフォールバックし、
		// 署名を誰でも自作できる状態になる)。better-auth 側の fail-fast は
		// `NODE_ENV === "production"` が条件で workerd では発火しないため、
		// `src/lib/auth.ts` が起動時に自前で検査して logError する(#389)。
		BETTER_AUTH_SECRET?: string;
		STRIPE_SECRET_KEY?: string;
		STRIPE_WEBHOOK_SECRET?: string;
		// 既存プレミアム会員の期間延長キャンペーンコード。"CODE=days" をカンマ区切り。
		// 推測による悪用を防ぐためシークレット扱い(wrangler secret put で投入)。
		CAMPAIGN_EXTENSION_CODES?: string;
		// エチケット解析の高精度経路(Claude + web検索)を有効にする Anthropic APIキー。
		// 未設定でもアプリは動作し、GPT経路→従来の Workers AI 経路の順に引き継がれる。
		ANTHROPIC_API_KEY?: string;
		// エチケット解析の高精度経路(GPT-5.6 Luna + web検索)を有効にする OpenAI APIキー。
		// 未設定でもアプリは動作し、Claude経路→従来の Workers AI 経路の順に引き継がれる。
		OPENAI_API_KEY?: string;
		// **サーバ側**の Sentry DSN(#395 / #486)。運用者が手を動かす必要がある事象
		// (決済の宙吊り・返金失敗・監査記録の欠落・AI原価の異常)を Workers から
		// 送る operator-alert と、予期しない例外を自動で拾う @sentry/cloudflare
		// (withSentry)の両方が読む。クライアントの `VITE_SENTRY_DSN`
		// (ビルド変数)とは投入先が別で、**未設定ならログだけ出して送信しない**。
		// DSN は公開値だが、ビルド成果物に埋め込まないようシークレットとして扱う。
		SENTRY_DSN?: string;
		// Web Push の VAPID 秘密鍵(#466)。対になる公開鍵は wrangler.jsonc の vars。
		// 未設定なら通知機能ごと無効になる(購読トグルも出さない)。
		// 投入: `wrangler secret put VAPID_PRIVATE_KEY`(プレビューは `--env preview`)。
		// **入れ替えると既存の購読は全て無効になる**(購読は公開鍵に紐づく)。
		VAPID_PRIVATE_KEY?: string;
		// Langfuse の API キー(#512)。AI 推論の入出力を追う LLM 可観測性。
		// 未設定なら計装は no-op（アプリは壊れない）。
		// 投入: `wrangler secret put LANGFUSE_PUBLIC_KEY` /
		// `wrangler secret put LANGFUSE_SECRET_KEY`（プレビューは `--env preview`）。
		// ローカルは `.dev.vars` に記載。
		LANGFUSE_PUBLIC_KEY?: string;
		LANGFUSE_SECRET_KEY?: string;
	}
}
