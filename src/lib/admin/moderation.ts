// 管理者による BAN(利用停止, #115)の純ロジック。BAN 期限(日数)の検証・上限を
// DB非依存の関数として切り出し、サーバの入力バリデーションとテストで共有する。
// 期限は任意で、未指定なら無期限 BAN。

/** BAN 期限の最小日数。 */
export const BAN_EXPIRES_MIN_DAYS = 1;
/** BAN 期限の最大日数(約10年。誤入力のガード)。 */
export const BAN_EXPIRES_MAX_DAYS = 3650;

export type BanExpiresError = "not_integer" | "too_small" | "too_large";

/**
 * BAN 期限の日数が有効(整数・[MIN, MAX] の範囲内)か検証する。無効ならその理由を、
 * 有効なら null を返す。期限そのものは任意(この関数は指定された場合のみ呼ぶ)。
 */
export function validateBanExpiresDays(days: number): BanExpiresError | null {
	if (!Number.isInteger(days)) return "not_integer";
	if (days < BAN_EXPIRES_MIN_DAYS) return "too_small";
	if (days > BAN_EXPIRES_MAX_DAYS) return "too_large";
	return null;
}
