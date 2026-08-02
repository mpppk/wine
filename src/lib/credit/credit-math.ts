import { MICRO_USD_PER_CREDIT } from "#/lib/billing/ai-pricing";

// 内部コスト単位(µUSD) ↔ 表示クレジットの換算。DB非依存の純関数として切り出し、
// 単体テスト可能にする。
//
// 以前は「内部トークン ↔ 表示クレジット」だったが、モデル/プロバイダで実費が1000倍
// 違う経路が混在するようになり、トークン数では原価に比例しなくなった(#355)。
// 内部の計上単位そのものを µUSD に変えたので、ここは µUSD → クレジットの換算になる。

/**
 * 内部コスト(µUSD)を表示クレジットに換算する。切り上げ(Math.ceil)なので、端数が
 * 出ても過小請求にならない。0以下は0。
 */
export function costToCredits(microUsd: number): number {
	if (microUsd <= 0) return 0;
	return Math.ceil(microUsd / MICRO_USD_PER_CREDIT);
}

/**
 * 予約(見積)クレジットと実測コスト(µUSD)から、返却すべきクレジットを求める。
 * 実測が見積を上回っても返却は負にならない(下限0でクランプ)。
 *
 * 予約は中心値見積なので実測が上振れすることがあるが、**予約を超えて課金はしない**
 * (過小請求側に倒す)。これは意図的な設計で、最悪値で予約すると高価な経路の予約額が
 * 月次付与を超え、経路自体が常時ブロックされるため(docs/ai-credit-system.md)。
 */
export function refundCredits(
	reservedCredits: number,
	actualMicroUsd: number,
): number {
	return Math.max(0, reservedCredits - costToCredits(actualMicroUsd));
}
