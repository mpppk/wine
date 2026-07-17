import { z } from "zod";
import { AOP_TAG_IDS } from "./tags";
import type { Aop, AopProducer } from "./types";
import { GRAPE_VARIETY_IDS } from "./varieties";

// aops.json(キュレーション済みデータ)のバリデーション。モジュール読み込み時と
// データ整合性テストの両方で使う。品種IDのenum化により参照切れを防ぐ。

// 生産者は「名前だけの文字列」と「検索キーワード・手動リンク付きオブジェクト」の
// 両方で書ける。読み込み時に AopProducer へ正規化する。
const producerSchema = z.union([
	z
		.string()
		.min(1)
		.transform((name): AopProducer => ({ name })),
	z.object({
		name: z.string().min(1),
		searchKeyword: z.string().min(1).optional(),
		links: z
			.object({
				rakuten: z.url().optional(),
				amazon: z.url().optional(),
			})
			.optional(),
	}),
]);

export const aopSchema = z
	.object({
		id: z.string().regex(/^[a-z0-9-]+$/),
		idApp: z.number().int().positive(),
		name: z.string().min(1),
		shortName: z.string().min(1),
		nameJa: z.string().min(1),
		region: z.enum([
			"bourgogne",
			"beaujolais",
			"champagne",
			"bordeaux",
			"piemonte",
			"alsace",
			"loire",
		]),
		subregionId: z.string().min(1),
		kind: z.enum(["regional", "village", "vineyard", "winery"]),
		villageAopIds: z
			.array(z.string().regex(/^[a-z0-9-]+$/))
			.min(1)
			.optional(),
		parentAopId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.optional(),
		isAppellation: z.boolean().optional(),
		tags: z.array(z.enum(AOP_TAG_IDS)).min(1).optional(),
		colors: z
			.array(z.enum(["red", "white", "rose", "sparkling", "sweet-white"]))
			.min(1),
		grapes: z
			.array(
				z.object({
					varietyId: z.enum(GRAPE_VARIETY_IDS as [string, ...string[]]),
					role: z.enum(["principal", "accessory"]),
				}),
			)
			.min(1),
		soil: z.string().min(1),
		producers: z.array(producerSchema).min(1),
		description: z.string().min(1),
	})
	// villageAopIds(親AOCへの参照)は畑とシャトーだけが持つ。シャトーは所属AOCを
	// ちょうど1つ持つ(複数村にまたがる畑と違い、シャトーの所在は一意)。
	.superRefine((aop, ctx) => {
		if (aop.villageAopIds && aop.kind !== "vineyard" && aop.kind !== "winery") {
			ctx.addIssue({
				code: "custom",
				path: ["villageAopIds"],
				message: `${aop.id}: villageAopIds は vineyard/winery のみが持てる`,
			});
		}
		if (aop.kind === "winery" && aop.villageAopIds?.length !== 1) {
			ctx.addIssue({
				code: "custom",
				path: ["villageAopIds"],
				message: `${aop.id}: winery は villageAopIds をちょうど1つ持つ必要がある`,
			});
		}
		// parentAopId(親畑への内包参照)は畑(クリマ)だけが持つ。親畑に内包される
		// クリマは村を親から導出するため villageAopIds を持たない。参照先の妥当性
		// (親が同一 region の vineyard か)は data-integrity テストで検証する。
		if (aop.parentAopId && aop.kind !== "vineyard") {
			ctx.addIssue({
				code: "custom",
				path: ["parentAopId"],
				message: `${aop.id}: parentAopId は vineyard のみが持てる`,
			});
		}
		if (aop.parentAopId && aop.villageAopIds) {
			ctx.addIssue({
				code: "custom",
				path: ["villageAopIds"],
				message: `${aop.id}: parentAopId を持つ畑は villageAopIds を持てない(村は親から導出)`,
			});
		}
	}) satisfies z.ZodType<Aop>;

export const aopArraySchema = z.array(aopSchema);
