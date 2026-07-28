import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { creditLedger } from "#/db/schema";
import { NotFoundError } from "#/lib/errors";
import { answerRegionQuestion } from "./ai-service";

// ai-service のクレジット予約まわりを実D1で検証する。AI バインディングはテスト環境に
// 用意していない(vitest.config.ts)ため、env.AI.run に到達する経路は対象にせず、
// 「予約する前に落ちる/予約したら必ず補償される」という予約の前後関係だけを見る。

async function ledgerRowsOf(userId: string) {
	return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

describe("answerRegionQuestion のモデル解決順序 (#245)", () => {
	it("モデル解決の失敗で予約が無記録で消えない", async () => {
		// preferredAiModel の解決は userService.getCurrentUser 経由で D1 を読む。
		// ユーザ行が無ければ NotFoundError になり、D1 の一時エラーと同じ形で throw する。
		// この throw が予約の後・try の外で起きると、予約が返却も記録もされずに消える(#245)。
		const userId = "ai-service-missing-user";
		expect(
			await db.select().from(user).where(eq(user.id, userId)),
		).toHaveLength(0);

		await expect(
			answerRegionQuestion(userId, {
				regionId: "bourgogne",
				question: "シャブリの土壌は?",
			}),
		).rejects.toBeInstanceOf(NotFoundError);

		// 予約より前に落ちるので台帳には何も残らない。モデル解決が予約の後にあると、
		// ここに返却されないままの consume 行(と月次付与の grant 行)が残る。
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});
});
