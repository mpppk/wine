import { z } from "zod";

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

/**
 * モデルキーの許可リスト検証スキーマ。**書き込み経路と読み取り経路で共有する SSOT**(#256)。
 *
 * 読み取り側(resolveModelKey)が許可リストで弾いていても、書き込み側が素通しだと
 * user 行に任意長の文字列が入る(認証済みユーザによるストレージ肥大・管理画面詳細の
 * ペイロード膨張)。better-auth の `user.additionalFields.preferredAiModel.validator.input`
 * と MCP ツール引数、UI 側の復元をこのスキーマ1本に寄せ、許可リストが増減しても
 * 経路ごとの取りこぼしが出ないようにする。
 *
 * エラーメッセージは better-auth が 400 の message にそのまま載せ、プロフィール画面に
 * 表示されるため日本語にする。
 */
export const regionQaModelKeySchema = z.enum(REGION_QA_MODEL_KEYS, {
	error: "対応していないAIモデルです。",
});

/**
 * 任意の値を許可リストと照合し、モデルキーでなければ `null` を返す。
 * 「不正値は既定にフォールバックする」読み取り側は `?? DEFAULT_REGION_QA_MODEL` で使う。
 */
export function toRegionQaModelKey(value: unknown): RegionQaModelKey | null {
	const parsed = regionQaModelKeySchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

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

// ---- エチケット解析の高精度経路(Anthropic Claude + web検索) ----
// ANTHROPIC_API_KEY が設定されている場合のみ使う。未設定・失敗時は Workers AI
// (AI_LABEL_MODEL)へフォールバックするため、ここの定数は任意機能の調整値。

/**
 * エチケット解析エンジンの許可リスト。ユーザがプロフィール画面で選択できる。
 * クライアントにはキーだけを送らせ、サーバ側で経路に解決する(地域Q&Aの
 * REGION_QA_MODEL_KEYS と同じ流儀)。
 *  - web-research: Claude + web検索の高精度経路(ANTHROPIC_API_KEY 必須。
 *    未設定・失敗時は workers-ai へフォールバック)。クレジット消費が大きい。
 *  - workers-ai: 従来の Workers AI 経路。消費が小さい。
 */
export const LABEL_ENGINE_KEYS = ["web-research", "workers-ai"] as const;

/** ユーザが選択できるエチケット解析エンジンのキー。ワイヤ上の値(クライアント⇄サーバ)。 */
export type LabelEngineKey = (typeof LABEL_ENGINE_KEYS)[number];

/** 選択可能なエンジンの表示定義。UI(プロフィール画面)が参照する。 */
export const AI_LABEL_ENGINES: Record<
	LabelEngineKey,
	{ label: string; description: string }
> = {
	"web-research": {
		label: "高精度(Claude + web検索)",
		description:
			"AIがweb検索で生産者・呼称・品種を裏取りします。クレジット消費が大きめです。利用できない環境では自動的に標準で解析されます。",
	},
	"workers-ai": {
		label: "標準(Workers AI)",
		description: "写真の読み取りのみで解析します。クレジット消費が小さめです。",
	},
};

/** 未設定・不正値のときの既定エンジン。現行挙動(キー設定時は高精度)を維持する。 */
export const DEFAULT_LABEL_ENGINE: LabelEngineKey = "web-research";

/**
 * エンジンキーの許可リスト検証スキーマ。**書き込み経路(better-auth の
 * additionalFields validator)と読み取り経路(analyzeWineLabel)で共有する SSOT**
 * (#256 の preferredAiModel と同じ理由・同じ形)。エラーメッセージは better-auth が
 * 400 の message にそのまま載せ、プロフィール画面に表示されるため日本語にする。
 */
export const labelEngineKeySchema = z.enum(LABEL_ENGINE_KEYS, {
	error: "対応していない解析エンジンです。",
});

/** 任意の値を許可リストと照合し、エンジンキーでなければ `null` を返す。 */
export function toLabelEngineKey(value: unknown): LabelEngineKey | null {
	const parsed = labelEngineKeySchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * 高精度エチケット解析に使う Claude のモデルID。マルチモーダル + サーバーサイド
 * web検索ツール(web_search_20260209)を1リクエストで使える世代であること。
 * 原価を下げたい場合は "claude-sonnet-5" 等へ数値だけ差し替える。
 */
export const AI_LABEL_WEB_MODEL = "claude-opus-5";

/**
 * 1レスポンスの最大出力トークン。claude-opus-5 は thinking が既定で有効で、
 * max_tokens は thinking + 本文の合計上限のため、JSONだけの出力でも余裕を持たせる
 * (小さすぎると thinking で枠を使い切り本文が途切れる)。
 */
export const AI_LABEL_WEB_MAX_OUTPUT_TOKENS = 16_000;

/** 1回の解析で許可する web 検索回数の上限(tools の max_uses)。原価の上限化。 */
export const AI_LABEL_WEB_MAX_SEARCHES = 8;

/**
 * pause_turn(サーバー側ツールループの一時停止)からの再開回数の上限。
 * 再開ごとに入力を再送するためトークンを消費する。上限到達時はその時点の
 * 応答で打ち切る(通常は末尾にJSONが出力済み)。
 */
export const AI_LABEL_WEB_MAX_CONTINUATIONS = 4;

/**
 * Claude経路の予約見積の基礎トークン(プロンプト + 呼称/品種マスタのリスト +
 * web検索結果 + thinking/出力ぶんの保守的な見積)。検索結果の量は事前に読めない
 * ため大きめに取り、settle の実測確定で差分を返す。
 */
export const AI_LABEL_WEB_BASE_TOKEN_ESTIMATE = 30_000;

/** Claude経路の画像1枚あたりの入力トークン見積(長辺1280px前提 + ループ再送ぶん)。 */
export const AI_LABEL_WEB_IMAGE_TOKEN_ESTIMATE = 3_000;

/** 質問文の最大文字数(入力バリデーション)。 */
export const AI_MAX_QUESTION_CHARS = 300;

/**
 * サーバに渡す会話履歴の最大メッセージ数(直近から保持、超過は古い順に切り落とす)。
 * トークン/原価の上限化のため。8 = 4往復。
 */
export const AI_MAX_HISTORY_MESSAGES = 8;

/** 会話履歴1件あたりの最大文字数(入力バリデーション)。 */
export const AI_HISTORY_CONTENT_MAX_CHARS = 4000;

/**
 * 入力境界で受け付ける会話履歴の最大件数。
 *
 * サーバは clampHistory(region-qa.ts)で直近 AI_MAX_HISTORY_MESSAGES 件へ切り詰めるので、
 * **境界がそれを下回ってはならない**。下回ると履歴ポリシーを緩めた(例: 8 → 30)ときに
 * 境界が先に 400 を返し、設定変更が黙って効かなくなる(#340)。
 *
 * 一方でクライアントが多めに送ってきても弾かず穏当に切り詰めたいので、20 を下限の余裕
 * として持たせる(従来の境界値)。
 */
export const AI_HISTORY_INPUT_MAX_MESSAGES = Math.max(
	20,
	AI_MAX_HISTORY_MESSAGES,
);

/**
 * 会話履歴の入力スキーマ。**Web の server fn と MCP ツールの双方がこれを import する。**
 *
 * 層ごとに境界をリテラルで手書きすると、片方だけ直したときに受け付ける入力が食い違い、
 * ドメイン側の上限とも非連動になる(docs/architecture.md「上限値などの数値定数はドメイン
 * lib に置き、zod スキーマ・サービス層・UI の全員が同じ定数を import する」。#340)。
 */
export const chatHistorySchema = z
	.array(
		z.object({
			role: z.enum(["user", "assistant"]),
			content: z.string().min(1).max(AI_HISTORY_CONTENT_MAX_CHARS),
		}),
	)
	.max(AI_HISTORY_INPUT_MAX_MESSAGES);

/** 日本語混在テキストの粗いトークン見積で使う「1トークンあたりの文字数」。保守的に小さめ。 */
export const CHARS_PER_TOKEN_ESTIMATE = 2;
