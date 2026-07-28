// 一括クレジット補填(#116)の純ロジック。入力検証・上限を DB非依存の関数として切り出し、
// サーバの入力バリデーションとテストで共有する。

import { ADMIN_CREDIT_GRANT_MAX, ADMIN_CREDIT_GRANT_MIN } from "./credit-grant";

/**
 * 1回の一括付与で処理する対象ユーザ数の上限。
 *
 * **上限はこの数値単独では決まらない**。Workers は1リクエストあたりのサブリクエスト数を
 * 1,000に制限し、D1 の呼び出しもそこに計上される。したがって
 * 「上限件数 × 1ユーザあたりのD1呼び出し回数」が 1,000 を下回っている必要がある。
 * この不変条件は `bulkGrantSubrequestBudget()` が表し、テストが破れを検出する(#253)。
 */
export const ADMIN_BULK_GRANT_MAX_USERS = 200;

/** Workers の1リクエストあたりサブリクエスト上限。D1 呼び出しも計上される */
export const WORKERS_SUBREQUEST_LIMIT = 1000;

/**
 * 一括付与が使うサブリクエスト数の見積もり。`perUserD1Calls` は実装が1ユーザあたりに
 * 発行する D1 呼び出し回数で、実装を変えたらこの値を更新する(テストが実装と突き合わせる)。
 *
 * 直列ループで1ユーザ6回だった頃は 200 × 6 = 1,200 で上限を超え、150〜200人規模の
 * 障害補填が "Too many subrequests" で途中失敗して部分付与になっていた。requestId
 * 冪等化で再実行は安全だが、再実行でも付与済みユーザ分のクエリを消費するため
 * 完走できない、という詰み方をする。
 */
export function bulkGrantSubrequestBudget(perUserD1Calls: number): {
	users: number;
	perUser: number;
	total: number;
	withinLimit: boolean;
} {
	const total = ADMIN_BULK_GRANT_MAX_USERS * perUserD1Calls;
	return {
		users: ADMIN_BULK_GRANT_MAX_USERS,
		perUser: perUserD1Calls,
		total,
		withinLimit: total < WORKERS_SUBREQUEST_LIMIT,
	};
}
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
