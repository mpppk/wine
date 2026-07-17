// 地域チャットQ&A(Workers AI)の設定。モデルや上限はここに集約し、原価/品質を見て
// 数値だけ差し替えられるようにする。クレジット消費の見積上限は plans.ts 側に置く。

/**
 * 地域Q&Aに使う Workers AI モデル。日本語品質重視で GLM-5.2 を採用。原価/品質を見て切替可。
 * GLM-5.2 は reasoning(thinking)対応・出力上限は max_completion_tokens・推論努力は
 * reasoning_effort で制御する点が Llama 系と異なる(ai-service で吸収)。
 * @see https://developers.cloudflare.com/workers-ai/models/glm-5.2/
 */
export const AI_REGION_QA_MODEL = "@cf/zai-org/glm-5.2";

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
