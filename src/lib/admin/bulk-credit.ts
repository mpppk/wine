// 一括クレジット補填(#116)の純ロジック。入力検証・上限を DB非依存の関数として切り出し、
// サーバの入力バリデーションとテストで共有する。

import { ADMIN_CREDIT_GRANT_MAX, ADMIN_CREDIT_GRANT_MIN } from "./credit-grant";

/**
 * 1回の一括付与で処理する対象ユーザ数の上限。D1/Workers の実行時間制約下で安全に同期処理
 * できる件数に抑える(超える場合は期間を絞ってもらう)。より大規模なバッチ分割は将来対応。
 */
export const ADMIN_BULK_GRANT_MAX_USERS = 200;
/** インシデントID(冪等キーの名前空間)の最大文字数。 */
export const ADMIN_INCIDENT_ID_MAX = 100;
/** インシデントID に許可する文字(requestId に安全に埋め込める英数・ハイフン・アンダースコア)。 */
export const ADMIN_INCIDENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type BulkGrantError =
	| "incident_required"
	| "incident_invalid"
	| "amount_invalid"
	| "range_invalid";

/**
 * 一括付与の入力(インシデントID・付与額・対象期間)が有効か検証する。無効ならその理由を、
 * 有効なら null を返す。
 */
export function validateBulkGrant(input: {
	incidentId: string;
	amount: number;
	fromMs: number;
	toMs: number;
}): BulkGrantError | null {
	const incident = input.incidentId.trim();
	if (incident === "") return "incident_required";
	if (
		incident.length > ADMIN_INCIDENT_ID_MAX ||
		!ADMIN_INCIDENT_ID_PATTERN.test(incident)
	) {
		return "incident_invalid";
	}
	if (
		!Number.isInteger(input.amount) ||
		input.amount < ADMIN_CREDIT_GRANT_MIN ||
		input.amount > ADMIN_CREDIT_GRANT_MAX
	) {
		return "amount_invalid";
	}
	if (
		!Number.isFinite(input.fromMs) ||
		!Number.isFinite(input.toMs) ||
		input.fromMs >= input.toMs
	) {
		return "range_invalid";
	}
	return null;
}
