import { z } from "zod";
import type { Aop } from "./types";
import { GRAPE_VARIETY_IDS } from "./varieties";

// aops.json(キュレーション済みデータ)のバリデーション。モジュール読み込み時と
// データ整合性テストの両方で使う。品種IDのenum化により参照切れを防ぐ。

export const aopSchema = z.object({
	id: z.string().regex(/^[a-z0-9-]+$/),
	idApp: z.number().int().positive(),
	name: z.string().min(1),
	shortName: z.string().min(1),
	nameJa: z.string().min(1),
	region: z.enum(["bourgogne", "beaujolais"]),
	subregionId: z.string().min(1),
	classification: z.enum(["regional", "village", "grand-cru"]),
	villageAopIds: z
		.array(z.string().regex(/^[a-z0-9-]+$/))
		.min(1)
		.optional(),
	premierCru: z.boolean(),
	colors: z.array(z.enum(["red", "white", "rose", "sparkling"])).min(1),
	grapes: z
		.array(
			z.object({
				varietyId: z.enum(GRAPE_VARIETY_IDS as [string, ...string[]]),
				role: z.enum(["principal", "accessory"]),
			}),
		)
		.min(1),
	soil: z.string().min(1),
	producers: z.array(z.string().min(1)).min(1),
	description: z.string().min(1),
}) satisfies z.ZodType<Aop>;

export const aopArraySchema = z.array(aopSchema);
