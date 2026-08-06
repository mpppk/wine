import type { AiUsage } from "#/lib/billing/ai-pricing";

// Workers AI(env.AI.run)の応答 usage をクレジット計上用の `AiUsage` へ変換する純ロジック。
//
// 地域Q&A と エチケット解析の Workers AI 経路が**同じ換算を別々にインラインで書いていた**
// ため、片方だけ直すと計上がドリフトする形になっていた(docs/architecture.md
// 「同種の定義が2箇所以上に現れたらSSOT化する」)。経路ごとの usage マッパーを
// 1関数ずつ持つ形は Claude 経路(`toAnthropicUsage`)・GPT 経路(`toGptUsage`)と同じで、
// **会計の取りこぼし検知テスト(usage-accounting.test.ts)が全経路を同じ形で検査できる**
// ようにするための入口でもある。

/**
 * Workers AI の usage を `AiUsage` へ変換する。**usage が取れなければ `undefined`**。
 *
 * Workers AI は入力・出力の内訳を返さず `total_tokens` しか無いので、**全量を出力
 * トークンとして計上する**(出力単価は入力単価より高いので、保守的=過大請求側に倒れる)。
 * この経路は原価がほぼゼロなので実害は無い。
 *
 * 戻り値を `undefined` にできるようにしてあるのは、呼び出し側が「実測が取れなかった回」を
 * 見積で確定させる(fallbackCharge)分岐を持つため。ここで 0 を返すと、実測ゼロと
 * 実測欠落が区別できなくなる。
 */
export function toWorkersAiUsage(
	usage: { total_tokens?: number } | undefined,
): AiUsage | undefined {
	const total = usage?.total_tokens;
	if (total === undefined) return undefined;
	return { outputTokens: total };
}
