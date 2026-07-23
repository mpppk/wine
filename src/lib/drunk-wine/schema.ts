import { z } from "zod";

// 飲んだワイン(マイセラー)の入力バリデーション。Webのserver fnと
// MCPツールの両方から使うため、ランタイム依存(DB/R2)を持たない純粋な
// zodパーツに保つ。AOP・品種の存在検証は静的マスタ照合が必要なので
// サービス層(drunk-wine-service)で行う。

export const DRANK_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// フィールドの数値・文字数の上限下限。zod と UI(Web の DrunkWineForm /
// MCP App の編集フォーム)で同じ値を使うため、ここを単一情報源にする
// (docs/architecture.md「上限値などの数値定数はドメイン lib に置き…」)。
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const VINTAGE_MIN = 1800;
export const VINTAGE_MAX = 2100;
export const PRICE_MIN = 0;
export const PRICE_MAX = 10_000_000;
export const NAME_MAX = 200;
export const MEMO_MAX = 2000;
export const PRODUCER_MAX = 200;

// 形式だけでなく暦として実在する日付か(2026-02-31等を弾く)。
// Web はブラウザの date input が守るが、MCP経由は素の文字列が来る。
// 年は1900-2100に制限(飲んだ日の現実的な範囲。Date.UTCの0-99年→1900年代
// マッピングの罠も同時に回避する)。
function isCalendarDate(s: string): boolean {
	const [y, m, d] = s.split("-").map(Number);
	if (y === undefined || m === undefined || d === undefined) return false;
	if (y < 1900 || y > 2100) return false;
	const dt = new Date(Date.UTC(y, m - 1, d));
	return (
		dt.getUTCFullYear() === y &&
		dt.getUTCMonth() === m - 1 &&
		dt.getUTCDate() === d
	);
}

export const drunkWineFields = {
	name: z.string().trim().min(1).max(NAME_MAX),
	drankOn: z
		.string()
		.regex(DRANK_ON_PATTERN)
		.refine(isCalendarDate, "invalid calendar date")
		.optional(),
	aopId: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(80)
		.optional(),
	rating: z.number().int().min(RATING_MIN).max(RATING_MAX).optional(),
	memo: z.string().max(MEMO_MAX).optional(),
	vintage: z.number().int().min(VINTAGE_MIN).max(VINTAGE_MAX).optional(),
	grapeVarietyIds: z.array(z.string().max(80)).max(20).optional(),
	producer: z.string().max(PRODUCER_MAX).optional(),
	price: z.number().int().min(PRICE_MIN).max(PRICE_MAX).optional(),
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
