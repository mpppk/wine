import { TOKENS_PER_CREDIT } from "#/lib/billing/plans";

// 内部トークン ↔ 表示クレジットの換算。DB非依存の純関数として切り出し、単体テスト可能にする。

/**
 * 内部トークンを表示クレジットに換算する。切り上げ(Math.ceil)なので、端数が出ても
 * 過小請求にならない。0以下は0。
 */
export function tokensToCredits(tokens: number): number {
	if (tokens <= 0) return 0;
	return Math.ceil(tokens / TOKENS_PER_CREDIT);
}

/**
 * 予約(見積)クレジットと実測トークンから、返却すべきクレジットを求める。
 * 実測が見積を上回っても返却は負にならない(下限0でクランプ)。
 */
export function refundCredits(
	reservedCredits: number,
	actualTokens: number,
): number {
	return Math.max(0, reservedCredits - tokensToCredits(actualTokens));
}
