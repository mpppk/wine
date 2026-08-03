import { logInfo, logWarn } from "#/lib/logger";
import type { LabelFieldSources } from "./label-extraction";
import type { WebResearchTrace } from "./web-research-trace";

// AI推論1回ぶんの実行記録(構造化1行ログ)。**成功も含めて必ず1行出す**のがこの
// モジュールの存在理由。
//
// 元々このアプリのAIログは失敗パスにしか無く(`label gpt research failed` 等)、
// 成功経路が無言だった。そのため運用中に確認できるのは「警告が出ていない」ことだけで、
// これは「正常に動いた」と「そもそも誰も使っていない」を区別できない。実際 GPT-5.6 Luna
// 導入時(#357)の本番確認では、警告の不在に加えてクレジット台帳の `:settle` 行と見積式を
// 突き合わせるという間接的な推論に頼るしかなかった。台帳はたまたま副次的な証跡に
// なっていただけで、観測手段として設計されたものではない。
//
// ## ログに載せてよいもの
//
// 原則は**実行メタデータのみ**で、写真・質問文・抽出されたワイン名などのユーザ入力/出力は
// 載せない。
//
// **例外は `label_analysis` の高精度経路の裏取り情報(`webResearch` / `fieldSources`)**で、
// 検索クエリと参照URLをそのまま載せる。この経路の精度は「web検索で裏を取る」ことから
// 来ているのに、何を検索し何を読んだかは応答の外から一切見えず、推定が外れたときに
// 「写真の読み取りを間違えた」のか「拾った情報が間違っていた」のかを切り分ける手段が
// 無かった。検索結果は毎回変わるので、後から同じ写真で再実行しても再現しない — 実行時に
// 拾う以外の観測手段が無い。
//
// **代償として、この2フィールドからは利用者が解析した銘柄が復元できる**。検索クエリは
// ラベルから読み取った生産者名・ワイン名そのものだし、参照URLも Wine-Searcher の銘柄
// ページのように銘柄を含む。`userId` と同じ行に載るので「誰が何を解析したか」が読める。
// 承知のうえでの転換で、緩和は保持期間(Workers Logs は最大7日)と、ログ閲覧に
// `CLOUDFLARE_API_TOKEN` が要ることに依っている。**D1 へ永続化したり、他の feature へ
// 同種のフィールドを広げたりする場合は、この判断をやり直すこと。**
//
// 上記2フィールド以外に、抽出結果そのもの(ワイン名・生産者・ヴィンテージ等の値)を
// 載せる口は無い。`fieldSources` が持つのは「どこから来たか」と参照URLだけで、値は持たない。

/**
 * 記録対象のAI機能。**推論経路を足したらここに足す**(ログ検索の一次キー)。
 * 経路ごとに msg 文字列を変えると横断で見られなくなるため、msg は共通にして
 * この値で絞る。
 */
export type AiFeature = "label_analysis" | "region_qa" | "wine_list_analysis";

/**
 * 推論の結末。
 *  - ok: 推論に成功し、実測トークンで確定した
 *  - blocked: クレジット残高不足で推論せず返した(失敗ではない)
 *  - failed: 推論またはクレジット確定に失敗し、予約を返却した
 */
export type AiOutcome = "ok" | "blocked" | "failed";

export interface AiInferenceLog {
	feature: AiFeature;
	userId: string;
	/** クレジット台帳の request_id。ログと台帳を突き合わせる唯一のキー。 */
	requestId: string;
	outcome: AiOutcome;
	/** 予約開始からの経過時間(ms)。経路ごとの遅延比較に使う。 */
	durationMs: number;
	/** ユーザ選択(または既定)のエンジン/モデルキー。 */
	selected?: string;
	/** シークレットの設定状況を加味して「意図した」経路。 */
	route?: string;
	/**
	 * 実際に結果を出した経路。フォールバックが起きると route と食い違う。
	 * **この2つを別々に持つのが要点**で、1つしか記録しないと
	 * 「GPTで成功した」と「GPTが落ちて Workers AI が拾った」が区別できない。
	 */
	executedBy?: string;
	/** 実際に呼んだモデルID(例: gpt-5.6-luna)。 */
	model?: string;
	photoCount?: number;
	/** 実測トークン(観測値。課金の根拠ではない)。 */
	actualTokens?: number;
	/**
	 * 実測の原価(µUSD)。**settle に使った値**で、クレジット消費の根拠(#355)。
	 * トークン数は経路をまたぐと原価に比例しないため、単価改定や経路追加の妥当性は
	 * この値で評価する。`--grep "ai inference"` で経路別の実原価を集計できる。
	 */
	costMicroUsd?: number;
	/** 予約した原価(µUSD)。実測と並べて中心値見積の妥当性を評価する。 */
	reservedMicroUsd?: number;
	/**
	 * web検索の軌跡(高精度エチケット解析のみ)。何を検索し、どのURLを参照したか。
	 *
	 * **推論が失敗してフォールバックした回にも載せる**のが要点。「検索まで到達したが
	 * 結果を使えなかった」のか「そもそも検索できなかった」のかは、ここが空かどうかで
	 * 分かる(応答のパース失敗と検索の失敗は別物)。
	 */
	webResearch?: WebResearchTrace;
	/**
	 * モデルが自己申告したフィールドごとの根拠(写真から読んだ / 検索で補った / 裏取りした)。
	 * `webResearch` が「何を見たか」なら、こちらは「それをどう使ったか」。
	 * 値そのものは持たない(origin と参照URLのみ)。
	 */
	fieldSources?: LabelFieldSources;
	/** failed のときの例外。logger が cause まで畳んで文字列化する。 */
	err?: unknown;
}

/** ログ横断の共通メッセージ。`--grep "ai inference"` で全経路の実行履歴が引ける。 */
export const AI_INFERENCE_LOG_MESSAGE = "ai inference";

/**
 * 実行記録に載せるフィールドを組み立てる(純関数)。`undefined` のキーは落として
 * 1行を締まった形に保つ。`fellBack` は route と executedBy から導出するので、
 * 呼び出し側が判定を書かなくてよい(経路ごとに書くとドリフトする)。
 */
export function buildAiInferenceFields(
	entry: AiInferenceLog,
): Record<string, unknown> {
	const { err, route, executedBy, ...rest } = entry;
	const fields: Record<string, unknown> = { route, executedBy };
	for (const [key, value] of Object.entries(rest)) {
		if (value !== undefined) fields[key] = value;
	}
	// 両方揃っているときだけ判定できる。executedBy が無い(=推論に到達しなかった)
	// ケースで false を出すと「フォールバックしなかった」と誤読されるため出さない。
	if (route !== undefined && executedBy !== undefined) {
		fields.fellBack = route !== executedBy;
	}
	if (route === undefined) delete fields.route;
	if (executedBy === undefined) delete fields.executedBy;
	if (err !== undefined) fields.err = err;
	return fields;
}

/**
 * AI推論1回ぶんの実行記録を出す。失敗だけ warn に上げ、成功・残高不足は info。
 * **ログ呼び出しでリクエストを壊さない**(logger 側が直列化失敗も握る)。
 */
export function logAiInference(entry: AiInferenceLog): void {
	const fields = buildAiInferenceFields(entry);
	if (entry.outcome === "failed") {
		logWarn(AI_INFERENCE_LOG_MESSAGE, fields);
	} else {
		logInfo(AI_INFERENCE_LOG_MESSAGE, fields);
	}
}
