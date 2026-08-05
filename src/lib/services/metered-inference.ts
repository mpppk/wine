import { type AiInferenceLog, logAiInference } from "#/lib/ai/inference-log";
import type { CreditCharge } from "#/lib/billing/ai-pricing";
import { alertOperator } from "#/lib/observability/operator-alert";
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
export function recordInference(entry: AiInferenceLog): void {
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
export type MeteredInferenceLogFields = Pick<
	AiInferenceLog,
	"executedBy" | "model" | "webResearch" | "fieldSources"
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
}

/**
 * 推論本体の戻り。`charge` が settle に使う実測値で、`value` が呼び出し側の結果。
 * **charge を返させる**のは、settle をラッパー側に閉じ込めるため(呼び出し側に
 * settleReservation を書かせない)。
 */
export interface MeteredInferenceOutput<T> {
	value: T;
	charge: CreditCharge;
}

export type MeteredInferenceResult<T> =
	/** 残高不足で推論せずに返した(失敗ではない)。 */
	| { blocked: true; balance: number; required: number }
	| { blocked: false; value: T; charge: CreditCharge; balance: number };

/**
 * クレジットを予約して推論を1回走らせ、実測で確定する(失敗時は全額返却)。
 *
 * **D1 読み・env 解決・入力検証は呼ぶ前に済ませること**(#245)。この関数を呼んだ時点から
 * 予約が立ち、以後の失敗は infer の中で起きたものだけが返却される。
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
	const { estimate, requestId, logBase } = options;
	const startedAt = Date.now();
	const entryBase = { ...logBase, userId, requestId };

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		recordInference({
			...entryBase,
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
		});
		return { blocked: true, balance: res.balance, required: res.required };
	}

	// 推論中に判明した分。catch でも読むので try の外に置く。
	let extraFields: MeteredInferenceLogFields = {};
	const ctx: MeteredInferenceContext = {
		requestId,
		reservedMicroUsd: res.reservedMicroUsd,
		addLogFields(fields) {
			extraFields = { ...extraFields, ...fields };
		},
	};

	let output: MeteredInferenceOutput<T>;
	try {
		output = await infer(ctx);
		await creditService.settleReservation(
			userId,
			requestId,
			res.reservedCredits,
			output.charge,
		);
	} catch (e) {
		// 返却を試み、成否をログに残す。返却自体が失敗しても元の推論失敗例外 e を握り
		// 潰さず伝播する(#158)。
		await creditService.refundReservationOnFailure(
			userId,
			requestId,
			res.reservedCredits,
		);
		recordInference({
			...entryBase,
			...extraFields,
			outcome: "failed",
			durationMs: Date.now() - startedAt,
			reservedMicroUsd: res.reservedMicroUsd,
			err: e,
		});
		throw e;
	}
	recordInference({
		...entryBase,
		...extraFields,
		outcome: "ok",
		durationMs: Date.now() - startedAt,
		actualTokens: output.charge.tokens,
		costMicroUsd: output.charge.microUsd,
		reservedMicroUsd: res.reservedMicroUsd,
	});
	// settle 成功後は消費確定済み。getBalance の失敗で上の catch の全額返却が走ると
	// 消費がネットプラスになるため、残高参照は**必ず try の外**で行う(#144)。
	const after = await creditService.getBalance(userId);
	return {
		blocked: false,
		value: output.value,
		charge: output.charge,
		balance: after.balance,
	};
}
