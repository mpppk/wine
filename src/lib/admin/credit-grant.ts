// 管理者によるクレジット手動付与(#113 補填・お詫び)の純ロジック。付与額の検証・上限を
// DB非依存の関数として切り出し、サーバの入力バリデーションとテストで共有する。

/** 1回の管理付与で許容する最小クレジット数。 */
export const ADMIN_CREDIT_GRANT_MIN = 1;
/** 1回の管理付与で許容する最大クレジット数(暴走・誤入力のガード)。 */
export const ADMIN_CREDIT_GRANT_MAX = 100_000;
/** 付与理由の最大文字数。 */
export const ADMIN_GRANT_REASON_MAX = 500;

export type GrantAmountError = "not_integer" | "too_small" | "too_large";

/**
 * 付与額が有効(整数・[MIN, MAX] の範囲内)か検証する。無効ならその理由を、
 * 有効なら null を返す。
 */
export function validateGrantAmount(amount: number): GrantAmountError | null {
	if (!Number.isInteger(amount)) return "not_integer";
	if (amount < ADMIN_CREDIT_GRANT_MIN) return "too_small";
	if (amount > ADMIN_CREDIT_GRANT_MAX) return "too_large";
	return null;
}
