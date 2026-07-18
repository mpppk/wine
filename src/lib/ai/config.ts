// 地域チャットQ&A(Workers AI)の設定。モデルや上限はここに集約し、原価/品質を見て
// 数値だけ差し替えられるようにする。クレジット消費の見積上限は plans.ts 側に置く。

/**
 * 地域Q&Aに使う Workers AI モデル。Google Gemma 4 (26B A4B, MoE) を採用。
 * env.AI.run バインディングで呼べる(wrangler 4.111 / @cloudflare/vite-plugin 1.45 世代で
 * AiModels 型に登録済み)。
 *
 * 入出力は OpenAI Chat Completions 互換形式:
 *  - 入力: messages（従来同様）。出力上限は max_completion_tokens（max_tokens は deprecated）。
 *  - 出力: 回答は choices[0].message.content（従来テキスト生成の response ではない点に注意）。
 *    トークンは usage.total_tokens（従来と同名で流用可）。
 * ai-service 側は choices / response 両形式を吸収するため、原価/品質を見て従来型(Llama 系)へ
 * 差し替えても動く。
 * なお Gemma 4 は reasoning モデルで、既定の thinking が出力枠を食って本文が途中で切れる/
 * 空になるため、ai-service 側で chat_template_kwargs.enable_thinking=false により無効化している。
 *
 * 補足: #100 時点では GLM-5.2 / Gemma 4 は env.AI.run で "#options" エラーになり呼べなかったが、
 * これはローンチ過渡期の Cloudflare 側バインディング不整合で、wrangler / @cloudflare/vite-plugin
 * を対応世代へ更新することで解消した(両者はバージョンロックされたペアで、必ず一緒に上げる)。
 * GLM-5.2 は本世代でもまだ AiModels 未登録のためバインディング不可
 * (REST /v1/chat/completions 経由の別実装が必要)。
 * @see https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
 */
export const AI_REGION_QA_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** 1回の回答で生成する最大トークン(env.AI.run の max_completion_tokens)。予約はこれを含めて見積る。 */
export const AI_MAX_OUTPUT_TOKENS = 512;

/**
 * エチケット(ラベル)画像解析に使う Workers AI モデル。Llama 4 Scout(マルチモーダル)を採用。
 * 画像は messages の content 配列に image_url(data URI)として渡す(HTTP URLは不可)。
 * guided_json で JSON Schema に沿った構造化出力を強制できる。
 * 出力は従来テキスト生成形式(response 文字列)+ usage.total_tokens。
 * 地域Q&AのGemma 4はAiModels上で画像入力を受けないため、ここだけ別モデルにする。
 * @see https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/
 */
export const AI_LABEL_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** エチケット解析1回で生成する最大トークン(構造化JSONのみなので小さめ)。 */
export const AI_LABEL_MAX_OUTPUT_TOKENS = 512;

/**
 * 画像1枚の入力トークン見積(保守的)。Llama 4 は画像をタイル分割してトークン化するため
 * 実測に幅があるが、予約が実測を必ず上回るよう大きめに取る(クライアントは長辺1280pxに
 * 縮小してから送る前提)。
 */
export const AI_LABEL_IMAGE_TOKEN_ESTIMATE = 4000;

/** 質問文の最大文字数(入力バリデーション)。 */
export const AI_MAX_QUESTION_CHARS = 300;

/**
 * サーバに渡す会話履歴の最大メッセージ数(直近から保持、超過は古い順に切り落とす)。
 * トークン/原価の上限化のため。8 = 4往復。
 */
export const AI_MAX_HISTORY_MESSAGES = 8;

/** 日本語混在テキストの粗いトークン見積で使う「1トークンあたりの文字数」。保守的に小さめ。 */
export const CHARS_PER_TOKEN_ESTIMATE = 2;
