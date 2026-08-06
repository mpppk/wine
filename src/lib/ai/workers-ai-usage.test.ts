import { describe, expect, it } from "vitest";
import { toWorkersAiUsage } from "#/lib/ai/workers-ai-usage";

describe("toWorkersAiUsage", () => {
	it("total_tokens を全量「出力」として計上する(保守的=過大請求側)", () => {
		// Workers AI は入出力の内訳を返さない。出力単価は入力単価より高いので、
		// 全量を出力として扱うと原価を下回らない。
		expect(toWorkersAiUsage({ total_tokens: 812 })).toEqual({
			outputTokens: 812,
		});
	});

	it("usage が無ければ undefined(実測ゼロと実測欠落を区別する)", () => {
		// 呼び出し側は「実測が取れなかった回」を見積で確定させる分岐を持つ。0 を返すと
		// その分岐が効かなくなり、無課金で推論だけ走る回ができる。
		expect(toWorkersAiUsage(undefined)).toBeUndefined();
		expect(toWorkersAiUsage({})).toBeUndefined();
	});

	it("total_tokens が 0 なら実測ゼロとして扱う(undefined ではない)", () => {
		expect(toWorkersAiUsage({ total_tokens: 0 })).toEqual({ outputTokens: 0 });
	});
});
