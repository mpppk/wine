// 地域チャットQ&A(Workers AI)の設定。モデルや上限はここに集約し、原価/品質を見て
// 数値だけ差し替えられるようにする。クレジット消費の見積上限は plans.ts 側に置く。

/**
 * 地域Q&Aに使う Workers AI モデル。日本語品質重視で Gemma 4 を採用。原価/品質を見て切替可。
 * Gemma 4 は 2026年の新モデルで OpenAI互換IF(messages + max_completion_tokens +
 * reasoning_effort、thinking mode 内蔵)。呼び出しには新しめのエッジランタイムが必要なため
 * wrangler.jsonc の compatibility_date を 2026年に引き上げている。ai-service で緩い型で呼ぶ。
 * @see https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
 */
export const AI_REGION_QA_MODEL = "@cf/google/gemma-4-26b-a4b-it";

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
