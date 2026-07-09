import { z } from "zod";

// 飲んだワイン(マイセラー)の入力バリデーション。Webのserver fnと
// MCPツールの両方から使うため、ランタイム依存(DB/R2)を持たない純粋な
// zodパーツに保つ。AOP・品種の存在検証は静的マスタ照合が必要なので
// サービス層(drunk-wine-service)で行う。

export const DRANK_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const drunkWineFields = {
	name: z.string().trim().min(1).max(200),
	drankOn: z.string().regex(DRANK_ON_PATTERN).optional(),
	aopId: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(80)
		.optional(),
	rating: z.number().int().min(1).max(5).optional(),
	memo: z.string().max(2000).optional(),
	vintage: z.number().int().min(1800).max(2100).optional(),
	grapeVarietyIds: z.array(z.string().max(80)).max(20).optional(),
	producer: z.string().max(200).optional(),
	price: z.number().int().min(0).max(10_000_000).optional(),
};

export const createDrunkWineInput = z.object(drunkWineFields);

// 更新はidのみ必須、他は「指定されたフィールドだけ差し替え」。
// null は「クリアする」の意(optional=未指定は変更しない)。
export const updateDrunkWineInput = z.object({
	id: z.string().min(1).max(80),
	name: drunkWineFields.name.optional(),
	drankOn: drunkWineFields.drankOn.nullable().optional(),
	aopId: drunkWineFields.aopId.nullable().optional(),
	rating: drunkWineFields.rating.nullable().optional(),
	memo: drunkWineFields.memo.nullable().optional(),
	vintage: drunkWineFields.vintage.nullable().optional(),
	grapeVarietyIds: drunkWineFields.grapeVarietyIds.optional(),
	producer: drunkWineFields.producer.nullable().optional(),
	price: drunkWineFields.price.nullable().optional(),
});

export type CreateDrunkWineInput = z.infer<typeof createDrunkWineInput>;
export type UpdateDrunkWineInput = z.infer<typeof updateDrunkWineInput>;
