import { z } from "zod";
import {
	type AiUsage,
	type CreditCharge,
	toEstimateCharge,
} from "#/lib/billing/ai-pricing";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";

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

/**
 * Workers AI 経路の指示文(LABEL_PROMPT)の入力トークン見積。
 *
 * **`LABEL_PROMPT` の実長から計算せずに定数で持つ**。見積は解析前の必要クレジット表示
 * のためにクライアントも読むが、`label-extraction.ts` は AOP/品種の全マスタを推移的に
 * 読み込むためクライアントバンドルに入れたくない(一括抽出の見積を
 * ここへ置いたのと同じ理由)。実長(2026-08 時点で約5,600)がこの値を超えていない
 * ことは `label-extraction.test.ts` が検証する。マスタ名一覧を同梱しているので、
 * AOP/品種を増やすと伸びる。
 */
export const AI_LABEL_PROMPT_TOKEN_ESTIMATE = 6_500;

// ---- エチケット解析の高精度経路(LLM + web検索) ----
// 対応するプロバイダのAPIキーが設定されている場合のみ使う。未設定・失敗時は Workers AI
// (AI_LABEL_MODEL)へフォールバックするため、ここの定数は任意機能の調整値。

/**
 * エチケット解析エンジンの許可リスト。ユーザがプロフィール画面で選択できる。
 * クライアントにはキーだけを送らせ、サーバ側で経路に解決する(地域Q&Aの
 * REGION_QA_MODEL_KEYS と同じ流儀)。
 *  - gpt-luna: OpenAI GPT-5.6 Luna + web検索の高精度経路(OPENAI_API_KEY 必須)。
 *  - web-research: Anthropic Claude + web検索の高精度経路(ANTHROPIC_API_KEY 必須)。
 *  - workers-ai: 従来の Workers AI 経路。消費が小さい。
 *
 * 高精度2経路はいずれもキー未設定・実行失敗時にフォールバックする(resolveLabelRoute)。
 * **キーは値のまま D1 の user 行に残る**ため、許可リストからキーを消しても読み取り側の
 * フォールバック(toLabelEngineKey → 既定)が効くようにしてある。
 */
export const LABEL_ENGINE_KEYS = [
	"gpt-luna",
	"web-research",
	"workers-ai",
] as const;

/** ユーザが選択できるエチケット解析エンジンのキー。ワイヤ上の値(クライアント⇄サーバ)。 */
export type LabelEngineKey = (typeof LABEL_ENGINE_KEYS)[number];

/** 選択可能なエンジンの表示定義。UI(プロフィール画面)が参照する。 */
export const AI_LABEL_ENGINES: Record<
	LabelEngineKey,
	{ label: string; description: string }
> = {
	"gpt-luna": {
		label: "高精度(GPT-5.6 Luna + web検索)",
		description:
			"AIがweb検索で生産者・呼称・品種を裏取りします。利用できない環境では自動的に他の経路で解析されます。",
	},
	"web-research": {
		label: "高精度(Claude + web検索)",
		description:
			"AIがweb検索で生産者・呼称・品種を裏取りします。最も精度が高いぶん消費も最大です。利用できない環境では自動的に他の経路で解析されます。",
	},
	"workers-ai": {
		label: "標準(Workers AI)",
		description: "写真の読み取りのみで解析します。裏取りはしません。",
	},
};

/**
 * 未設定・不正値のときの既定エンジン。高精度経路を既定にする方針は #354 から変えず、
 * 担い手を GPT-5.6 Luna にする(同等の裏取り精度をより低い原価で得るため)。
 * OPENAI_API_KEY 未設定の環境では resolveLabelRoute が Claude → Workers AI の順に
 * 引き継ぐので、既定を変えても「キーがある経路が使われる」性質は保たれる。
 */
export const DEFAULT_LABEL_ENGINE: LabelEngineKey = "gpt-luna";

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
 * Claude経路の予約見積の基礎入力トークン(プロンプト + 呼称/品種マスタのリスト +
 * web検索結果 + ループ再送ぶん)。検索結果の量は事前に読めないため実測の中心値に置き、
 * 上振れは settle で取りこぼす(過小請求側)。
 */
export const AI_LABEL_WEB_BASE_TOKEN_ESTIMATE = 30_000;

/** Claude経路の画像1枚あたりの入力トークン見積(長辺1280px前提 + ループ再送ぶん)。 */
export const AI_LABEL_WEB_IMAGE_TOKEN_ESTIMATE = 3_000;

/**
 * Claude経路の出力トークン見積(thinking + JSON)。**入力と分けて持つ**のは
 * 出力単価が入力の5倍あり、合計トークンでは原価が出せないため。上限
 * (`AI_LABEL_WEB_MAX_OUTPUT_TOKENS` = 16k)ではなく実測の中心値を置く。
 *
 * 出力JSONにフィールドごとの根拠(`sources`: 7フィールド × origin + 参照URL)を
 * 載せるようにしたぶん、中心値を引き上げてある(実応答で計測した増分は約250)。
 */
export const AI_LABEL_WEB_OUTPUT_TOKEN_ESTIMATE = 2_300;

/**
 * Claude経路の web検索回数の見積。**上限(`AI_LABEL_WEB_MAX_SEARCHES` = 8)ではなく
 * 中心値**を置く。web検索は $10/1000回 の回数課金で、上限で予約すると1回の予約が
 * 付与枠を不必要に押さえてしまう。
 */
export const AI_LABEL_WEB_SEARCH_ESTIMATE = 6;

/**
 * 高精度エチケット解析に使う OpenAI のモデルID。マルチモーダル + サーバーサイドweb検索
 * (Responses API の web_search ツール)+ structured outputs を1リクエストで使える世代で
 * あること。上位が必要なら "gpt-5.6-terra" / "gpt-5.6-sol" へ数値だけ差し替える
 * (**"gpt-5.6" のエイリアスは Sol に解決されるため Luna 指定には使えない**)。
 * @see https://developers.openai.com/api/docs/models/gpt-5.6-luna
 */
export const AI_LABEL_GPT_MODEL = "gpt-5.6-luna";

/**
 * 1レスポンスの最大出力トークン(Responses API の max_output_tokens)。
 * **reasoning トークンもこの枠から出る**ため、JSONだけの出力でも余裕を持たせる。
 * 小さすぎると web検索と推論で枠を使い切り、status="incomplete" で本文JSONが
 * 出ないまま返る(Claude経路の AI_LABEL_WEB_MAX_OUTPUT_TOKENS と同じ理由)。
 */
export const AI_LABEL_GPT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * 推論の深さ(Responses API の reasoning.effort)。この経路の精度は「web検索で裏を取る」
 * ことから来ており、長い内省ではない。effort を上げると reasoning が出力枠を食って
 * 本文JSONが途切れる(incomplete)リスクとトークン消費が増えるため低めに固定する。
 */
export const AI_LABEL_GPT_REASONING_EFFORT = "low";

/**
 * web検索結果をどれだけコンテキストに載せるか(web_search ツールの search_context_size)。
 * Claude経路の max_uses と違い OpenAI は検索回数を直接は縛れないので、原価の上限化は
 * この値と max_output_tokens で行う。medium は既定値。
 */
export const AI_LABEL_GPT_SEARCH_CONTEXT_SIZE = "medium";

/**
 * GPT経路の予約見積の基礎入力トークン(プロンプト + 呼称/品種マスタのリスト +
 * web検索結果)。トークン数の見込みは Claude経路と同水準だが、**原価は単価表で
 * 決まる**ので消費クレジットは大きく違う(Luna の入力単価は Opus 5 の 1/25)。
 */
export const AI_LABEL_GPT_BASE_TOKEN_ESTIMATE = 30_000;

/** GPT経路の画像1枚あたりの入力トークン見積(長辺1280px前提)。 */
export const AI_LABEL_GPT_IMAGE_TOKEN_ESTIMATE = 3_000;

/**
 * GPT経路の出力トークン見積(reasoning + JSON)。上限ではなく実測の中心値。
 * Claude経路と同じく、根拠(`sources`)を出力させるぶんを織り込んである。
 */
export const AI_LABEL_GPT_OUTPUT_TOKEN_ESTIMATE = 2_300;

/**
 * GPT経路の web検索回数の見積。
 *
 * **この経路は検索回数に上限を掛けられない**(Responses API に Anthropic の
 * `max_uses` に相当する指定が無い)。Luna は原価の8割が web検索の回数課金なので、
 * 上振れした回は予約を超えたぶんを取りこぼす(過小請求)。回数の上限化は別Issueで扱う。
 */
export const AI_LABEL_GPT_SEARCH_ESTIMATE = 3;

/**
 * エンジンキーの解決先(実際に走る経路)。ユーザ選択(LabelEngineKey)と1対1ではなく、
 * **プロバイダキーの設定状況で降格しうる**ため別の型にする。
 */
export type LabelRoute = LabelEngineKey;

/**
 * 経路 → 実際に呼ぶモデルID。**実行記録のログが「どのモデルで解析したか」を
 * 書くために参照する**。ログ側でモデル名をリテラル指定すると、モデルを差し替えた
 * ときにログだけ古い名前を出し続け、観測が静かに嘘になるため導出可能にしておく。
 */
export const AI_LABEL_ROUTE_MODELS: Record<LabelRoute, string> = {
	"gpt-luna": AI_LABEL_GPT_MODEL,
	"web-research": AI_LABEL_WEB_MODEL,
	"workers-ai": AI_LABEL_MODEL,
};

/** 高精度経路の利用可否(= 対応するシークレットが設定されているか)。 */
export interface LabelProviderAvailability {
	/** OPENAI_API_KEY が設定されている。 */
	openai: boolean;
	/** ANTHROPIC_API_KEY が設定されている。 */
	anthropic: boolean;
}

/**
 * ユーザ選択のエンジンキーを、実際に走らせる経路へ解決する。**選択と実行の対応づけは
 * ここだけに置く**(ai-service が `!!key && engine === "..."` を経路ごとに書くと、
 * 経路が増えるたびに条件がドリフトし、片方のキーだけ設定された環境で黙って標準へ
 * 落ちる。#354 の `useWebResearch` を一般化したもの)。
 *
 * 高精度が選ばれてキーが無い場合は、**標準へ落とす前にもう一方の高精度経路を試す**。
 * ユーザの意思表示は「web検索で裏取りしてほしい」であって特定ベンダーではないため、
 * 既定を gpt-luna に変えても ANTHROPIC_API_KEY だけの環境(#354 時点の本番)が
 * Workers AI へ降格しない。
 */
export function resolveLabelRoute(
	engine: LabelEngineKey,
	availability: LabelProviderAvailability,
): LabelRoute {
	if (engine === "workers-ai") return "workers-ai";
	// 高精度の希望順: 選択されたプロバイダ → もう一方 → 標準
	const preferred: LabelRoute[] =
		engine === "gpt-luna"
			? ["gpt-luna", "web-research"]
			: ["web-research", "gpt-luna"];
	for (const route of preferred) {
		if (route === "gpt-luna" && availability.openai) return route;
		if (route === "web-research" && availability.anthropic) return route;
	}
	return "workers-ai";
}

// ---- 写真からのワイン一括抽出(Issue #358) ----
// レストランのワインリスト・ショップの棚など、複数銘柄が写った写真から銘柄の配列を
// 取り出す経路。エチケット解析(1解析=1本)とは出力の形が違うので定数も分けて持つ。

/**
 * 一括抽出で走りうる経路。**エチケット解析のエンジン選択(`LABEL_ENGINE_KEYS`)から
 * `workers-ai` を除いたもの**(#426)。
 *
 * Workers AI を含めないのは #358 の決定を維持するため: Llama 4 Scout は配列の
 * guided_json が安定せず、小さな文字が並ぶリスト写真の読み取り品質も低い。降格すると
 * 「大量の欠落・でたらめな銘柄」が出て、レビュー画面での修正コストがユーザの手入力を
 * 上回る。落とすなら黙って質を下げるより失敗させる。
 */
export const WINE_LIST_ROUTE_KEYS = ["gpt-luna", "web-research"] as const;

/** 一括抽出で実際に走る経路。 */
export type WineListRoute = (typeof WINE_LIST_ROUTE_KEYS)[number];

/**
 * 一括抽出に使う Claude のモデルID。マルチモーダルで複数画像を1リクエストに載せ、
 * 写真横断の重複統合まで1回の推論でやらせる。
 *
 * **Opus 5 ではなく Sonnet 5 を使う(#355)**。コスト基準の計上に切り替えると、Opus 5
 * ($5/$25 per MTok)では写真1枚の解析が無料会員の月次付与(150クレジット = $0.15)を
 * 超え、無料会員がこの機能を一度も使えなくなる。Sonnet 5($3/$15)なら1枚あたり
 * 約126クレジットで付与内に収まる。web検索を使わない素直な読み取りタスクなので、
 * Llama 4 Scout で問題になった「配列の構造化出力の安定性」は Sonnet 5 でも満たせる。
 */
export const AI_WINE_LIST_CLAUDE_MODEL = "claude-sonnet-5";

/**
 * 一括抽出に使う OpenAI のモデルID(#426)。エチケット解析の GPT 経路
 * (`AI_LABEL_GPT_MODEL`)と**別定数で持つ**——あちらは web検索での裏取り精度、こちらは
 * 「小さな文字が数十行並ぶリスト写真の読み取り」で選ぶので、差し替えたい理由が独立している。
 *
 * Sonnet 5 に対する利点は2つ:
 *  - 原価が桁で下がる($0.2/$1.2 per MTok = Sonnet 5 の 1/15・1/12.5)。一括抽出は
 *    写真枚数に比例して伸びるので、ここが無料会員の月次付与を圧迫していた。
 *  - structured outputs(strict)で出力形式を強制できる。Claude 経路は形を
 *    `buildWineListPrompt` の指示文でしか担保できず、銘柄配列は壊れると全滅する。
 */
export const AI_WINE_LIST_GPT_MODEL = "gpt-5.6-luna";

/**
 * 経路 → 実際に呼ぶモデルID。**予約見積・実測換算・実行記録のログがすべてここを引く**
 * (`AI_LABEL_ROUTE_MODELS` と同じ流儀)。ログ側でモデル名をリテラル指定すると、
 * モデルを差し替えたときにログだけ古い名前を出し続け、観測が静かに嘘になる。
 */
export const AI_WINE_LIST_ROUTE_MODELS: Record<WineListRoute, string> = {
	"gpt-luna": AI_WINE_LIST_GPT_MODEL,
	"web-research": AI_WINE_LIST_CLAUDE_MODEL,
};

/**
 * 一括抽出のエンジン選択を、実際に走らせる経路へ解決する(#426)。**返せる経路が
 * 無ければ `null`**——この機能は Workers AI へ降格しないので、「使えない」を
 * 型で表現する(呼び出し側は導線を隠す / 503 を返す)。
 *
 * 設定は**エチケット解析と同じ `preferredLabelEngine` を共有する**。一括専用の
 * ユーザ設定を新設すると user テーブルの列と better-auth の additionalFields が
 * 増えるが、ユーザの意思表示は「web検索で裏取りしてほしいか」ではなく
 * 「どのベンダーの読み取りを信用するか」でどちらも同じであり、分ける実益がない。
 *
 * **`workers-ai` を選んでいるユーザも高精度経路に載せる**。その選択の動機はコスト抑制
 * だが、一括抽出の従来の実装は Sonnet 5 固定で、Luna はそれより安い。降格先が無い以上
 * 「一括登録だけ使えない」にするより、より安い経路に載せるほうが選択の意図に沿う。
 */
export function resolveWineListRoute(
	engine: LabelEngineKey,
	availability: LabelProviderAvailability,
): WineListRoute | null {
	// 高精度の希望順: 選択されたプロバイダ → もう一方(resolveLabelRoute と同じ規則)。
	// workers-ai 選択時は既定と同じ順(gpt-luna 優先)に載せる。
	const preferred: WineListRoute[] =
		engine === "web-research"
			? ["web-research", "gpt-luna"]
			: ["gpt-luna", "web-research"];
	for (const route of preferred) {
		if (route === "gpt-luna" && availability.openai) return route;
		if (route === "web-research" && availability.anthropic) return route;
	}
	return null;
}

/**
 * 1レスポンスの最大出力トークン。**銘柄数に比例して伸びる**のがエチケット解析との
 * 決定的な違いで、枠が足りないとリストの末尾が丸ごと落ちる。thinking も同じ枠から
 * 出る(AI_LABEL_WEB_MAX_OUTPUT_TOKENS と同じ事情)ため大きめに取る。
 * 打ち切りは truncated フラグとしてUIに出し、「写真を分けて再解析」を案内する。
 *
 * **これ以上大きくするならストリーミングへの切り替えが要る**。Anthropic SDK は
 * 非ストリーミングの `messages.create` に対し max_tokens から推定所要時間を計算し、
 * 10分を超える見積(= おおよそ 21,000 トークン超)をリクエスト送信前に throw する
 * ("Streaming is required for operations that may take longer than 10 minutes")。
 * 銘柄1件あたりの出力は 100 トークン弱で、件数上限(AI_WINE_LIST_MAX_WINES)ぶんでも
 * 1万トークンに届かないため、現状はこの枠で足りる。
 */
export const AI_WINE_LIST_MAX_OUTPUT_TOKENS = 20_000;

/**
 * 1回の抽出で受け取る銘柄数の上限。モデルがこれを超えて列挙してきた場合は切り捨て、
 * truncated = true として扱う(レビュー画面が数十枚のカードで固まるのを防ぐ原価/UXの
 * 上限化。出力トークン上限とは別の防御)。
 */
export const AI_WINE_LIST_MAX_WINES = 80;

/**
 * 一括抽出の予約見積の基礎入力トークン(指示文 + 呼称/品種マスタのリスト)。
 *
 * **他経路のように「上限いっぱいを保守的に予約する」ことはしない**。予約は残高不足の
 * 判定に直結し(reserveCredits が足りなければ推論せず blocked)、10枚 × 上限見積を
 * 積むと無料枠では常に弾かれて機能自体が使えなくなる。実測の中心値(写真数枚・
 * 数十銘柄で 15〜30k)を見て置き、上振れぶんは取りこぼす(settle は予約を超えて
 * 課金しない = 過小請求側に倒れる)。**この「中心値で予約する」方針は #355 で
 * 全経路の既定になった**(コスト基準では最悪値予約が付与額を超えるため)。
 */
export const AI_WINE_LIST_BASE_TOKEN_ESTIMATE = 21_000;

/**
 * 画像1枚あたりの入力トークン見積。リストの小さい文字を読ませるためクライアントは
 * 長辺 1600px へ縮小して送る(エチケットの 1280px より大きい)ので、その前提で
 * エチケット経路(3,000)より大きめに取る。
 */
export const AI_WINE_LIST_IMAGE_TOKEN_ESTIMATE = 3_500;

/**
 * 一括抽出の基礎出力トークン見積(thinking + JSON の骨格)。入力と分けて持つのは
 * 出力単価が入力の5倍あるため。
 */
export const AI_WINE_LIST_BASE_OUTPUT_TOKEN_ESTIMATE = 3_000;

/**
 * GPT経路の基礎出力トークン見積。**reasoning トークンも出力枠から出る**ぶん、
 * Claude経路(3,000)より大きく取る。エチケット解析の GPT 経路と同じ事情
 * (`AI_LABEL_GPT_MAX_OUTPUT_TOKENS` のコメント参照)。
 */
export const AI_WINE_LIST_GPT_BASE_OUTPUT_TOKEN_ESTIMATE = 4_000;

/**
 * GPT経路の推論の深さ(Responses API の reasoning.effort)。この経路の精度は
 * 「写真を丁寧に読む」ことから来ており、長い内省ではない。effort を上げると
 * reasoning が出力枠を食い、銘柄数に比例して伸びる本文JSONが途中で切れる
 * (status="incomplete")リスクだけが増えるため低めに固定する。
 */
export const AI_WINE_LIST_GPT_REASONING_EFFORT = "low";

/**
 * 画像1枚あたりの追加出力トークン見積。**この経路だけ出力が銘柄数に比例して伸びる**
 * (エチケット解析は1枚でも複数枚でも出力は1件ぶん)ので、枚数に連動させる。
 */
export const AI_WINE_LIST_OUTPUT_TOKEN_PER_IMAGE = 500;

// ---- 予約見積(コスト単位) ----
// 各経路の「中心値の使用量」を AiUsage として組み立て、単価表(ai-pricing.ts)で µUSD へ
// 換算する。**見積と実測が同じ型・同じ換算関数を通る**ので、単価を改定したときに
// 見積だけ古いまま残ることがない。
//
// **抽出ロジック(label-extraction.ts / wine-list-extraction.ts)ではなくここに置く**。
// 解析前に必要クレジットを表示する UI がこの式を参照するが、それらのモジュールは静的
// マスタ(AOP/品種の全リスト)を推移的に読み込むため、クライアントバンドルに入れたく
// ない。見積の定数と式が同じファイルに並ぶので、原価を見て数値を差し替えるときの
// 追随漏れも減る。

/**
 * 一括抽出の中心値使用量。写真枚数に比例させ、上限枚数でクランプする。
 *
 * **入力側は経路で分けない**: 指示文もマスタのグラウンディングも画像も両経路で同じで、
 * トークン数の見込みに差が出る理由が無い(原価の違いは単価表が受け持つ)。出力側だけ
 * 経路で分けるのは、GPT経路の reasoning が出力枠から出るため。
 *
 * どちらの経路も **web検索は使わない**(#358 の住み分け)ので `webSearches` は 0。
 */
export function estimateWineListReserveUsage(
	route: WineListRoute,
	imageCount: number,
): AiUsage {
	const photos = Math.min(Math.max(1, imageCount), MAX_PHOTOS_PER_IMPORT_BATCH);
	const baseOutput =
		route === "gpt-luna"
			? AI_WINE_LIST_GPT_BASE_OUTPUT_TOKEN_ESTIMATE
			: AI_WINE_LIST_BASE_OUTPUT_TOKEN_ESTIMATE;
	return {
		inputTokens:
			AI_WINE_LIST_BASE_TOKEN_ESTIMATE +
			AI_WINE_LIST_IMAGE_TOKEN_ESTIMATE * photos,
		outputTokens: baseOutput + AI_WINE_LIST_OUTPUT_TOKEN_PER_IMAGE * photos,
	};
}

/** 一括抽出の予約計上量。上限で必ずクランプする。 */
export function estimateWineListReserveCharge(
	route: WineListRoute,
	imageCount: number,
): CreditCharge {
	return toEstimateCharge(
		AI_WINE_LIST_ROUTE_MODELS[route],
		estimateWineListReserveUsage(route, imageCount),
	);
}

/**
 * エチケット解析の中心値使用量。**経路ごとに形が違う**ので経路で分ける: 高精度2経路は
 * 全写真を1リクエストにまとめて web検索で裏を取り、Workers AI 経路は1枚ずつ解析して
 * マージする(指示文も枚数ぶん送られる)。
 */
export function estimateLabelReserveUsage(
	route: LabelRoute,
	imageCount: number,
): AiUsage {
	const photos = Math.max(1, imageCount);
	switch (route) {
		case "gpt-luna":
			return {
				inputTokens:
					AI_LABEL_GPT_BASE_TOKEN_ESTIMATE +
					AI_LABEL_GPT_IMAGE_TOKEN_ESTIMATE * photos,
				outputTokens: AI_LABEL_GPT_OUTPUT_TOKEN_ESTIMATE,
				webSearches: AI_LABEL_GPT_SEARCH_ESTIMATE,
			};
		case "web-research":
			return {
				inputTokens:
					AI_LABEL_WEB_BASE_TOKEN_ESTIMATE +
					AI_LABEL_WEB_IMAGE_TOKEN_ESTIMATE * photos,
				outputTokens: AI_LABEL_WEB_OUTPUT_TOKEN_ESTIMATE,
				webSearches: AI_LABEL_WEB_SEARCH_ESTIMATE,
			};
		case "workers-ai":
			return {
				inputTokens:
					(AI_LABEL_PROMPT_TOKEN_ESTIMATE + AI_LABEL_IMAGE_TOKEN_ESTIMATE) *
					photos,
				outputTokens: AI_LABEL_MAX_OUTPUT_TOKENS * photos,
			};
	}
}

/** エチケット解析の予約計上量。上限で必ずクランプする。 */
export function estimateLabelReserveCharge(
	route: LabelRoute,
	imageCount: number,
): CreditCharge {
	return toEstimateCharge(
		AI_LABEL_ROUTE_MODELS[route],
		estimateLabelReserveUsage(route, imageCount),
	);
}

/**
 * 地域Q&Aの中心値使用量。入力は会話履歴の実長から見積り、出力は上限を置く
 * (1回の回答は短く、上限に張り付きやすいため中心値 ≒ 上限)。
 */
export function estimateRegionQaReserveUsage(promptTokens: number): AiUsage {
	return { inputTokens: promptTokens, outputTokens: AI_MAX_OUTPUT_TOKENS };
}

/** 地域Q&Aの予約計上量。モデルはユーザ選択で変わるので呼び出し側が渡す。 */
export function estimateRegionQaReserveCharge(
	modelKey: RegionQaModelKey,
	promptTokens: number,
): CreditCharge {
	return toEstimateCharge(
		AI_REGION_QA_MODELS[modelKey].id,
		estimateRegionQaReserveUsage(promptTokens),
	);
}

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
