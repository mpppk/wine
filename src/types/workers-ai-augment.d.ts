// Workers AI のモデル一覧(env.AI.run の型)に Gemma 4 を追加する宣言マージ。
//
// 背景: 地域Q&Aは @cf/google/gemma-4-26b-a4b-it を採用しているが、リポジトリに
// コミットされた worker-configuration.d.ts(wrangler types 生成)の世代では、本モデルの
// 型クラス(Base_Ai_Cf_Google_Gemma_4_26B_A4B_IT)は宣言されているものの AiModels マップ
// には未登録で、env.AI.run のモデル名として型解決できない。
//
// Cloudflare 側ではバインディング提供済み(新しい wrangler 世代の生成型では AiModels に登録
// される)ため、ランタイム動作には問題ない。一方 wrangler 本体を上げると @cloudflare/vite-plugin
// が生成する dist/server/wrangler.json の legacy_env を新 wrangler が拒否し、デプロイが壊れる。
// そこで wrangler は据え置いたまま、この最小の宣言マージで型解決だけを補う。
// 将来 cf-typegen 再生成で AiModels に載れば本ファイルは削除してよい。
interface AiModels {
	"@cf/google/gemma-4-26b-a4b-it": Base_Ai_Cf_Google_Gemma_4_26B_A4B_IT;
}
