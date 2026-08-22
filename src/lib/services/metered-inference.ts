import { type AiInferenceLog, logAiInference } from "#/lib/ai/inference-log";
import type { AiUsage, CreditCharge } from "#/lib/billing/ai-pricing";
import {
	type LangfuseGenerationInput,
	type LangfuseSpanInput,
	type LangfuseTraceHandle,
	startLangfuseTrace,
} from "#/lib/observability/langfuse";
import { alertOperator } from "#/lib/observability/operator-alert";
import { withSpan } from "#/lib/observability/span";
import * as creditService from "#/lib/services/credit-service";

// クレジットを消費するAI推論の共通骨格(#392)。
//
// 「予約 → 推論 → 実測確定 / 失敗時返却」は、過去に**壊れるたびに実害を出してきた**
// 順序制約の塊で(#143〜#147/#158/#245〜#247)、それが3つのAI機能に逐語コピーで
// 3重複製されていた。守るべき制約は typecheck もテストも強制しない「書く順番」であり、
// 4つ目の機能を足す人が正しく書き写せるかどうかに賭けている状態だった。
//
// ここを通す形にすると、次の4つが**構造で**担保される。
//
//  1. **読み取りは予約より前**(#245): D1 読み・env 解決は runMeteredInference を呼ぶ前に
//     済む。予約後の throw は必ず infer の中で起き、下の catch(返却)に届く。
//     予約の後・try の外で await する余地が呼び出し側に残らない
//  2. **getBalance は try の外**(#144): settle 成功後に残高参照で落ちても、catch の
//     全額返却は走らない(走ると消費がネットプラスになる)
//  3. **返却失敗が元例外をマスクしない**(#158): 返却は refundReservationOnFailure に
//     任せ、catch は必ず元の例外 e を再 throw する
//  4. **blocked/failed/ok の実行記録3点セット**(#370): 3経路とも同じ組み立てで出る。
//     経路ごとに書いていたためフィールド構成が既にドリフトしていた
//     (failed に executedBy/model が載るのは label だけだった)
//
// docs/architecture.md の「クレジットを消費する新機能は必ずこのパターンに従う」は、
// これで「書き写す規約」ではなく「呼ぶチョークポイント」になる。

/**
 * 実行記録を出し、**失敗なら運用者向けの通知も出す**(#395)。AI推論の記録は
 * すべてここを通す(経路ごとに書くと、経路が増えたときに通知だけ漏れる)。
 *
 * 通知に載せるのは実行メタデータの**明示した部分集合だけ**。実行記録には
 * `webResearch` / `fieldSources` という「解析した銘柄が復元できる」フィールドがあり、
 * これは保持7日・APIトークン必須の Workers Logs に限る取り決めになっている
 * (docs/deployment.md)。まとめて転送すると、その判断を黙って外部へ広げてしまう。
 *
 * 個々の失敗そのものは即時対応を要さない(ユーザには返却済み)ので level は warning。
 * **見たいのは頻度**——推論が落ち続ければプロバイダへの原価だけが出ていくので、
 * 閾値はコード側で発明せず Sentry のアラートルール(件数/期間)に委ねる。
 */
function recordInference(entry: AiInferenceLog): void {
	logAiInference(entry);
	if (entry.outcome !== "failed") return;
	alertOperator(
		"ai inference failed",
		{
			feature: entry.feature,
			userId: entry.userId,
			requestId: entry.requestId,
			route: entry.route,
			executedBy: entry.executedBy,
			model: entry.model,
			durationMs: entry.durationMs,
			reservedMicroUsd: entry.reservedMicroUsd,
			err: entry.err,
		},
		{
			level: "warning",
			tags: { kind: "ai_inference_failed", feature: entry.feature },
		},
	);
}

/**
 * 結末によらず全ての実行記録(blocked/ok/failed)に載る静的な実行メタデータ。
 *
 * `userId` / `requestId` / `outcome` / `durationMs` と、実測・予約の金額系は
 * ラッパーが埋めるので持たない(呼び出し側が書くとドリフトする)。
 */
export type MeteredInferenceLogBase = Omit<
	AiInferenceLog,
	| "userId"
	| "requestId"
	| "outcome"
	| "durationMs"
	| "actualTokens"
	| "costMicroUsd"
	| "reservedMicroUsd"
	| "err"
>;

/** 推論中に判明し、**ok と failed の両方**の実行記録に載せたいフィールド。 */
type MeteredInferenceLogFields = Pick<
	AiInferenceLog,
	"executedBy" | "model" | "webResearch" | "fieldSources" | "verified" | "steps"
>;

/** 推論本体(infer)に渡す実行コンテキスト。 */
export interface MeteredInferenceContext {
	/** クレジット台帳の request_id。ログと台帳を突き合わせる唯一のキー。 */
	readonly requestId: string;
	/**
	 * 予約した原価(µUSD)。実測が取れなかった回の床に使う経路がある。
	 * **降格しうる経路では予約額をそのまま床にしない**(#404。理由は ai-service 側の
	 * fallbackCharge の説明を参照)。
	 */
	readonly reservedMicroUsd: number;
	/**
	 * ok/failed **両方**の実行記録に載せる追加フィールドを積む。
	 *
	 * 降格した実行経路(`executedBy`)や裏取りの軌跡(`webResearch`)は「推論が失敗した回
	 * にも残したい」情報で、これが無いと呼び出し側は try の外に `let` を置いて catch と
	 * ok の両方で読む形を再発明することになる(その形の崩れが #370 のログ欠落だった)。
	 */
	addLogFields(fields: MeteredInferenceLogFields): void;
	/**
	 * モデル呼び出し1回を Langfuse の generation として報告する(#512)。
	 *
	 * `addLogFields` と同じく「推論中に判明したものを積む」形にし、呼び出し側に
	 * `startObservation` を書かせない（構造化ログが新ドメインで未適用になった #166 と
	 * 同じ失敗の形を避ける）。キー未設定なら no-op。
	 */
	recordGeneration(input: LangfuseGenerationInput): void;
	/**
	 * ツール実行・web検索1回ぶんを Langfuse の span として報告する(#514)。
	 * `recordGeneration` と同じ理由で、呼び出し側に `startObservation` を書かせない。
	 */
	recordSpan(input: LangfuseSpanInput): void;
}

/**
 * 推論本体の戻り。`charge` が settle に使う実測値で、`value` が呼び出し側の結果。
 * **charge を返させる**のは、settle をラッパー側に閉じ込めるため(呼び出し側に
 * settleReservation を書かせない)。
 */
export interface MeteredInferenceOutput<T> {
	value: T;
	charge: CreditCharge;
	/**
	 * 実測の使用量の**内訳**。実行記録に残すために要る。
	 *
	 * `charge` はトークン数と µUSD に畳んだ後の値なので、**原価に効くのにトークンに
	 * 現れない項目がここで消える**——web検索は $10/1000回 の回数課金で、高精度経路では
	 * 原価の大半を占めるのに `charge.tokens` には1つも現れない。#474 の本番確認で
	 * 「予約41 / 実測13クレジット」の差が出たとき、検索が何回走ったのかをログから
	 * 復元できず、見積が厚いのか検索が少なかったのかを切り分けられなかった。
	 *
	 * **必須にしてある**。省略可にすると、経路を足した人が渡し忘れても型が通り、
	 * その経路だけ観測が欠ける(CLAUDE.md の「横断的な規約は共通チョークポイントに
	 * 寄せる」)。実測が取れない経路は空オブジェクトを渡す——「取れなかった」ことが
	 * 記録に残るほうが、黙って欠けるより良い。
	 */
	usage: AiUsage;
}

export type MeteredInferenceResult<T> =
	/** 残高不足で推論せずに返した(失敗ではない)。 */
	| { blocked: true; balance: number; required: number }
	| { blocked: false; value: T; charge: CreditCharge; balance: number };

/**
 * 成立した予約。**確定・返却に必要な値の全部**で、これ以外を確定側へ持ち回る必要が
 * 無いようにしてある(ジョブ経路はこれを D1 に永続化して別リクエストで確定する)。
 */
export interface MeteredInferenceReservation {
	/** 台帳の冪等キー。settle / refund の requestId はここから導出される */
	readonly requestId: string;
	/** 予約した表示クレジット */
	readonly reservedCredits: number;
	/** 予約した原価(µUSD) */
	readonly reservedMicroUsd: number;
}

export type BeginMeteredInferenceResult =
	/** 残高不足で予約が立たなかった(失敗ではない)。 */
	| { blocked: true; balance: number; required: number }
	| { blocked: false; reservation: MeteredInferenceReservation };

/**
 * 予約だけを立てる(#460)。**推論と同じリクエストで確定しない経路のための入口**。
 *
 * 同期経路(runMeteredInference)は begin と finish を続けて呼ぶだけなので、この分割で
 * 挙動は変わらない。分けているのはジョブ経路のためで、そちらは
 *
 *   投入リクエスト: begin → 予約をジョブ行に永続化 → enqueue
 *   コンシューマ  : ジョブ行から予約を復元 → finish(推論 → 確定 / 失敗なら返却)
 *
 * と2つの実行に跨がる。**予約と確定を別々に書き下ろさせない**のがここの役目で、
 * 「予約したら必ず確定か返却で閉じる」という順序制約(#143〜#147 / #158 / #245〜#247)を
 * 経路の数だけ書き写す形に戻さないためにある(#392 と同じ動機)。
 *
 * **D1 読み・env 解決・入力検証は呼ぶ前に済ませること**(#245)。予約が立った後の失敗は
 * すべて呼び出し側の責任で返却しなければならず(finish か abandon)、その窓は短いほどよい。
 *
 * @param options.estimate 予約する見積。経路が決まってから作る(経路で単価が数十倍違う)
 * @param options.requestId 台帳の冪等キー。`<feature>:<uuid>` 形式
 * @param options.logBase blocked の実行記録に載る静的な実行メタデータ
 */
export async function beginMeteredInference(
	userId: string,
	options: {
		estimate: CreditCharge;
		requestId: string;
		logBase: MeteredInferenceLogBase;
		/** blocked の durationMs の起点。省略時は呼び出し時刻 */
		startedAt?: number;
	},
): Promise<BeginMeteredInferenceResult> {
	const { estimate, requestId, logBase, startedAt = Date.now() } = options;
	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		recordInference({
			...logBase,
			userId,
			requestId,
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
		});
		return { blocked: true, balance: res.balance, required: res.required };
	}
	return {
		blocked: false,
		reservation: {
			requestId,
			reservedCredits: res.reservedCredits,
			reservedMicroUsd: res.reservedMicroUsd,
		},
	};
}

/** 予約が成立した後の推論の結末(blocked はここには来ない)。 */
export interface FinishMeteredInferenceResult<T> {
	value: T;
	charge: CreditCharge;
	balance: number;
}

/**
 * 成立済みの予約で推論を1回走らせ、実測で確定する(失敗時は全額返却して再 throw)。
 *
 * 予約後の順序制約はすべてここに閉じている:
 *
 *  1. **推論の失敗は必ず返却に届く**: infer の throw だけが catch に入る形になっており、
 *     呼び出し側が予約と try の間に await を挟む余地が無い
 *  2. **getBalance は try の外**(#144): settle 成功後に残高参照で落ちても、catch の
 *     全額返却は走らない(走ると消費がネットプラスになる)
 *  3. **返却失敗が元例外をマスクしない**(#158): 返却は refundReservationOnFailure に
 *     任せ、catch は必ず元の例外 e を再 throw する
 *  4. **ok/failed の実行記録**が同じ組み立てで出る(#370)
 *
 * @param options.startedAt durationMs の起点。ジョブ経路は「推論を始めた時刻」を渡す
 *   (投入から完了までの待ち時間を推論時間として記録しない)
 */
export async function finishMeteredInference<T>(
	userId: string,
	options: {
		reservation: MeteredInferenceReservation;
		logBase: MeteredInferenceLogBase;
		startedAt?: number;
	},
	infer: (ctx: MeteredInferenceContext) => Promise<MeteredInferenceOutput<T>>,
): Promise<FinishMeteredInferenceResult<T>> {
	const { reservation, logBase, startedAt = Date.now() } = options;
	const { requestId, reservedCredits, reservedMicroUsd } = reservation;
	const entryBase = { ...logBase, userId, requestId };

	// 推論中に判明した分。catch でも読むので try の外に置く。
	let extraFields: MeteredInferenceLogFields = {};
	// Langfuse trace（root observation）。キー未設定なら null（no-op）。
	// `createTraceId(requestId)` で決定的に導出し、ログの requestId・台帳の
	// request_id・Langfuse のトレースURLが同じキーで直結する(#512)。
	let langfuseTrace: LangfuseTraceHandle | null = null;
	try {
		langfuseTrace = await startLangfuseTrace({
			name: `ai:${logBase.feature}`,
			requestId,
			feature: logBase.feature,
			metadata: {
				route: logBase.route,
				selected: logBase.selected,
				model: logBase.model,
				photoCount: logBase.photoCount,
			},
		});
	} catch {
		// 計装の失敗で推論を壊さない
	}
	const ctx: MeteredInferenceContext = {
		requestId,
		reservedMicroUsd,
		addLogFields(fields) {
			extraFields = { ...extraFields, ...fields };
		},
		recordGeneration(input) {
			langfuseTrace?.recordGeneration(input);
		},
		recordSpan(input) {
			langfuseTrace?.recordSpan(input);
		},
	};

	// **Workers AI は自動計装の対象外**なので、ここでスパンを張る(#504)。範囲を
	// 「推論だけ」ではなく確定・返却まで含めた finish 全体にしてあるのは、遅さや失敗が
	// 推論の外側(settle の D1 書き込み、返却の再試行)で起きることがあり、そこを外すと
	// 「推論は速いのにレスポンスが遅い」がトレースから消えるため。
	// userId は載せない(理由は observability/span.ts の冒頭)。requestId でログと繋がる。
	return withSpan(
		"ai_inference",
		{
			"wine.ai.feature": logBase.feature,
			"wine.ai.request_id": requestId,
			"wine.ai.selected": logBase.selected,
			"wine.ai.route": logBase.route,
			"wine.ai.reserved_micro_usd": reservedMicroUsd,
		},
		async (span) => {
			let output: MeteredInferenceOutput<T>;
			try {
				output = await infer(ctx);
				await creditService.settleReservation(
					userId,
					requestId,
					reservedCredits,
					output.charge,
				);
			} catch (e) {
				// 返却を試み、成否をログに残す。返却自体が失敗しても元の推論失敗例外 e を握り
				// 潰さず伝播する(#158)。
				await creditService.refundReservationOnFailure(
					userId,
					requestId,
					reservedCredits,
				);
				// 降格した実行経路(executedBy)は失敗した回にも残す——実行記録と同じ理由で、
				// 「どのモデルで落ちたか」が無いとトレース側だけ経路が分からなくなる(#370)。
				span.set({
					"wine.ai.outcome": "failed",
					"wine.ai.executed_by": extraFields.executedBy,
					"wine.ai.model": extraFields.model,
				});
				langfuseTrace?.end({
					outcome: "failed",
					errorMessage: e instanceof Error ? e.message : String(e),
				});
				recordInference({
					...entryBase,
					...extraFields,
					outcome: "failed",
					durationMs: Date.now() - startedAt,
					reservedMicroUsd,
					err: e,
				});
				throw e;
			}
			span.set({
				"wine.ai.outcome": "ok",
				"wine.ai.executed_by": extraFields.executedBy,
				"wine.ai.model": extraFields.model,
				"wine.ai.tokens": output.charge.tokens,
				"wine.ai.cost_micro_usd": output.charge.microUsd,
				"wine.ai.web_searches": output.usage.webSearches,
			});
			langfuseTrace?.end({ outcome: "ok", output: output.value });
			recordInference({
				...entryBase,
				...extraFields,
				outcome: "ok",
				durationMs: Date.now() - startedAt,
				actualTokens: output.charge.tokens,
				costMicroUsd: output.charge.microUsd,
				reservedMicroUsd,
				// 回数課金の web検索はトークンに現れないので、内訳から明示的に載せる。
				// **0回も記録する**(undefined と 0 は別物——前者は「経路が渡していない」、
				// 後者は「検索しなかった」で、見積の評価では意味が正反対になる)。
				...(output.usage.webSearches === undefined
					? {}
					: { webSearches: output.usage.webSearches }),
			});
			// settle 成功後は消費確定済み。getBalance の失敗で上の catch の全額返却が走ると
			// 消費がネットプラスになるため、残高参照は**必ず try の外**で行う(#144)。
			const after = await creditService.getBalance(userId);
			return {
				value: output.value,
				charge: output.charge,
				balance: after.balance,
			};
		},
	);
}

/**
 * 推論を**走らせずに**予約を返却して打ち切る(#460)。
 *
 * ジョブ経路には「予約は成立したが推論に到達できない」結末がある——写真の保存や
 * enqueue の失敗、コンシューマが死んで `running` のまま放置されたジョブの決着。
 * finish の catch と**同じ組み立て**(返却 + failed の実行記録)を通し、経路ごとに
 * 「返却だけして記録を忘れる/記録だけして返却を忘れる」形が生まれないようにする。
 *
 * **これは新しい回収機構ではない**。ここで返せなかった予約(プロセスごと死んだ場合)は
 * credit-service の `reclaimOrphanReservations` が次の予約時に拾う(#246)。ジョブ側に
 * 別の回収ループを作ると二重回収になるので作らない。
 */
export async function abandonMeteredInference(
	userId: string,
	options: {
		reservation: MeteredInferenceReservation;
		logBase: MeteredInferenceLogBase;
		startedAt?: number;
	},
	err: unknown,
): Promise<void> {
	const { reservation, logBase, startedAt = Date.now() } = options;
	await creditService.refundReservationOnFailure(
		userId,
		reservation.requestId,
		reservation.reservedCredits,
	);
	recordInference({
		...logBase,
		userId,
		requestId: reservation.requestId,
		outcome: "failed",
		durationMs: Date.now() - startedAt,
		reservedMicroUsd: reservation.reservedMicroUsd,
		err,
	});
}

/**
 * クレジットを予約して推論を1回走らせ、実測で確定する(失敗時は全額返却)。
 *
 * **D1 読み・env 解決・入力検証は呼ぶ前に済ませること**(#245)。この関数を呼んだ時点から
 * 予約が立ち、以後の失敗は infer の中で起きたものだけが返却される。
 *
 * 中身は `beginMeteredInference` → `finishMeteredInference` の合成そのもので、同期経路の
 * 呼び出し側にその2段階を意識させないための糖衣。
 *
 * @param options.estimate 予約する見積。経路が決まってから作る(経路で単価が数十倍違う)
 * @param options.requestId 台帳の冪等キー。`<feature>:<uuid>` 形式
 * @param options.logBase 全ての結末に載る静的な実行メタデータ
 * @param infer 推論本体。throw すると予約は全額返却され、例外はそのまま伝播する
 */
export async function runMeteredInference<T>(
	userId: string,
	options: {
		estimate: CreditCharge;
		requestId: string;
		logBase: MeteredInferenceLogBase;
	},
	infer: (ctx: MeteredInferenceContext) => Promise<MeteredInferenceOutput<T>>,
): Promise<MeteredInferenceResult<T>> {
	// 予約前から測る(従来どおり)。予約の待ちも1リクエストの所要時間の一部。
	const startedAt = Date.now();
	const begun = await beginMeteredInference(userId, { ...options, startedAt });
	if (begun.blocked) {
		return { blocked: true, balance: begun.balance, required: begun.required };
	}
	const done = await finishMeteredInference(
		userId,
		{
			reservation: begun.reservation,
			logBase: options.logBase,
			startedAt,
		},
		infer,
	);
	return {
		blocked: false,
		value: done.value,
		charge: done.charge,
		balance: done.balance,
	};
}
