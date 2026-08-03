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
	}
}
