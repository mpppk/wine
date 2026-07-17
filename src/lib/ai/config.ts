// 地域チャットQ&A(Workers AI)の設定。モデルや上限はここに集約し、原価/品質を見て
// 数値だけ差し替えられるようにする。クレジット消費の見積上限は plans.ts 側に置く。

/**
 * 地域Q&Aに使う Workers AI モデル。Google Gemma 4 (26B A4B, MoE) を採用。
 * env.AI.run バインディングで呼べる(wrangler 4.111 世代で AiModels 型に登録済み)。
 *
 * 入出力は OpenAI Chat Completions 互換形式:
 *  - 入力: messages（従来同様）。出力上限は max_completion_tokens（max_tokens は deprecated）。
 *  - 出力: 回答は choices[0].message.content（従来テキスト生成の response ではない点に注意）。
 *    トークンは usage.total_tokens（従来と同名で流用可）。
 * ai-service 側は choices / response 両形式を吸収するため、原価/品質を見て従来型(Llama 系)へ
 * 差し替えても動く。
 *
 * 補足: #100 時点では GLM-5.2 / Gemma 4 は env.AI.run で "#options" エラーになり呼べなかったが、
 * これはローンチ過渡期の Cloudflare 側バインディング不整合で、wrangler 更新後の再生成型では
 * Gemma 4 が AiModels に載り解消した。GLM-5.2 は本 wrangler 世代でもまだ AiModels 未登録のため
 * バインディングでは選べない(REST /v1/chat/completions 経由の別実装が必要)。
 * @see https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
 */
export const AI_REGION_QA_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** 1回の回答で生成する最大トークン(env.AI.run の max_completion_tokens)。予約はこれを含めて見積る。 */
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
