// 管理者によるプレミアム期間延長(#114 お詫び)の純ロジック。延長日数の検証・上限を
// DB非依存の関数として切り出し、サーバの入力バリデーションとテストで共有する。

/** 1回の管理延長で許容する最小日数。 */
export const ADMIN_EXTENSION_MIN_DAYS = 1;
/** 1回の管理延長で許容する最大日数(誤入力のガード)。 */
export const ADMIN_EXTENSION_MAX_DAYS = 365;

export type ExtensionDaysError = "not_integer" | "too_small" | "too_large";

/**
 * 延長日数が有効(整数・[MIN, MAX] の範囲内)か検証する。無効ならその理由を、
 * 有効なら null を返す。
 */
export function validateExtensionDays(days: number): ExtensionDaysError | null {
	if (!Number.isInteger(days)) return "not_integer";
	if (days < ADMIN_EXTENSION_MIN_DAYS) return "too_small";
	if (days > ADMIN_EXTENSION_MAX_DAYS) return "too_large";
	return null;
}
