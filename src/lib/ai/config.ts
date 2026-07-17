// 地域チャットQ&A(Workers AI)の設定。モデルや上限はここに集約し、原価/品質を見て
// 数値だけ差し替えられるようにする。クレジット消費の見積上限は plans.ts 側に置く。

/**
 * 地域Q&Aに使う Workers AI モデル。最新 Meta 世代の Llama 4 Scout を採用。原価/品質を見て切替可。
 * 標準の messages + max_tokens インターフェースで呼べる(env.AI.run バインディング対応・追加設定不要)。
 * 注意: GLM-5.2 / Gemma 4 等の OpenAI互換系モデルは env.AI.run では "#options" エラーで呼べない
 * (compatibility_date を 2026 に上げても preview エッジで再現)。それらを使うには
 * /v1/chat/completions 互換エンドポイント対応の別実装が必要。切替時は従来型(Llama 系等)を選ぶこと。
 * @see https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/
 */
export const AI_REGION_QA_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** 1回の回答で生成する最大トークン(env.AI.run の max_tokens)。予約はこれを含めて見積る。 */
export const AI_MAX_OUTPUT_TOKENS = 512;

/** 質問文の最大文字数(入力バリデーション)。 */
export const AI_MAX_QUESTION_CHARS = 300;

/**
 * サーバに渡す会話履歴の最大メッセージ数(直近から保持、超過は古い順に切り落とす)。
 * トークン/原価の上限化のため。8 = 4往復。
 */
export const AI_MAX_HISTORY_MESSAGES = 8;

/** 日本語混在テキストの粗いトークン見積で使う「1トークンあたりの文字数」。保守的に小さめ。 */
export const CHARS_PER_TOKEN_ESTIMATE = 2;
