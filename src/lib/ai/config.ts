// 地域チャットQ&A(Workers AI)の設定。モデルや上限はここに集約し、原価/品質を見て
// 数値だけ差し替えられるようにする。クレジット消費の見積上限は plans.ts 側に置く。

/**
 * 地域Q&Aに使う Workers AI モデルの許可リスト。ユーザがチャットで選択できる。
 * クライアントにはキー(gemma4 / llama4)だけを送らせ、サーバ側でキー→実モデルID＋
 * 固有オプションに解決する(任意のモデルIDを env.AI.run へ直接渡さないための許可リスト)。
 *
 * いずれも env.AI.run バインディングで呼べる(wrangler 4.111 / @cloudflare/vite-plugin 1.45
 * 世代で AiModels 型に登録済み)。
 *
 * 入出力形式はモデルで異なる:
 *  - Chat Completions 互換(Gemma 4 等): 回答は choices[0].message.content。
 *  - 従来テキスト生成(Llama 系等): 回答は response。
 *  ai-service 側は両形式を吸収する。出力上限は max_completion_tokens、トークンは
 *  usage.total_tokens(両形式共通)。
 *
 * モデル固有オプション(extraOptions)は env.AI.run へ展開して渡す。Gemma 4 は reasoning
 * モデルで、既定の thinking が出力枠を食って本文が途中で切れる/空になるため
 * chat_template_kwargs.enable_thinking=false で無効化する。Llama 4 はこのオプション不要。
 *
 * 補足: #100 時点では GLM-5.2 / Gemma 4 は env.AI.run で "#options" エラーになり呼べなかったが、
 * これはローンチ過渡期の Cloudflare 側バインディング不整合で、wrangler / @cloudflare/vite-plugin
 * を対応世代へ更新することで解消した(両者はバージョンロックされたペアで、必ず一緒に上げる)。
 * GLM-5.2 は本世代でもまだ AiModels 未登録のためバインディング不可
 * (REST /v1/chat/completions 経由の別実装が必要)。
 * @see https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
 * @see https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/
 */
export const REGION_QA_MODEL_KEYS = ["gemma4", "llama4"] as const;

/** ユーザが選択できる地域Q&Aモデルのキー。ワイヤ上の値(クライアント⇄サーバ)。 */
export type RegionQaModelKey = (typeof REGION_QA_MODEL_KEYS)[number];

export interface RegionQaModel {
	/** UI表示名。 */
	label: string;
	/** Workers AI のモデルID。 */
	id: string;
	/** env.AI.run に追加で渡すモデル固有オプション(Gemma の thinking 無効化など)。 */
	extraOptions?: Record<string, unknown>;
}

/** 選択可能なモデルの定義。キーはワイヤ値、値は解決先のID＋固有オプション。 */
export const AI_REGION_QA_MODELS: Record<RegionQaModelKey, RegionQaModel> = {
	gemma4: {
		label: "Gemma 4",
		id: "@cf/google/gemma-4-26b-a4b-it",
		// 思考出力を無効化しないと reasoning が出力枠(512)を先に食い、本文が途中で切れる/空になる。
		extraOptions: { chat_template_kwargs: { enable_thinking: false } },
	},
	llama4: {
		label: "Llama 4",
		id: "@cf/meta/llama-4-scout-17b-16e-instruct",
	},
};

/** model 省略時の既定モデル。現行挙動(Gemma 4)を維持する。 */
export const DEFAULT_REGION_QA_MODEL: RegionQaModelKey = "gemma4";

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
