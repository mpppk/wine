import { z } from "zod";
import { WINE_STATUS_IDS } from "./status";

// マイセラーの入力バリデーション。Webのserver fnと MCPツールの両方から使うため、
// ランタイム依存(DB/R2)を持たない純粋な zodパーツに保つ。AOP・品種の存在検証は
// 静的マスタ照合が必要なのでサービス層(drunk-wine-service)で行う。
//
// 銘柄(drunkWineFields)と飲用記録(wineTastingFields)を分けて持つ。飲んだ日・評価・
// メモは「同じワインを複数回飲む」を扱うため飲用記録側に属する(Issue #195)。
// 暦日検証と評価・メモの上限を共有するため同じファイルに置く。

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

/** 銘柄(ボトル)の属性。飲用ごとに変わらないものだけを置く */
export const drunkWineFields = {
	name: z.string().trim().min(1).max(NAME_MAX),
	// 所有状態。未指定は DEFAULT_WINE_STATUS(finished)としてサービス層が埋める
	status: z.enum(WINE_STATUS_IDS).optional(),
	aopId: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(80)
		.optional(),
	vintage: z.number().int().min(VINTAGE_MIN).max(VINTAGE_MAX).optional(),
	grapeVarietyIds: z.array(z.string().max(80)).max(20).optional(),
	producer: z.string().max(PRODUCER_MAX).optional(),
	price: z.number().int().min(PRICE_MIN).max(PRICE_MAX).optional(),
};

/** 飲用記録(1銘柄に複数持てる) */
export const wineTastingFields = {
	drankOn: z
		.string()
		.regex(DRANK_ON_PATTERN)
		.refine(isCalendarDate, "invalid calendar date")
		.optional(),
	rating: z.number().int().min(RATING_MIN).max(RATING_MAX).optional(),
	memo: z.string().max(MEMO_MAX).optional(),
};

export const createWineTastingInput = z.object(wineTastingFields);

// 作成時は飲用記録を同時に1件持てる(銘柄と同じ db.batch で原子的に作る)。
export const createDrunkWineInput = z.object({
	...drunkWineFields,
	tasting: createWineTastingInput.optional(),
});

// 更新はidのみ必須、他は「指定されたフィールドだけ差し替え」。
// null は「クリアする」の意(optional=未指定は変更しない)。
//
export const updateDrunkWineInput = z.object({
	id: z.string().min(1).max(80),
	name: drunkWineFields.name.optional(),
	// NOT NULL 列なのでクリア不可(fields.ts の clear:"never" と対応)
	status: drunkWineFields.status,
	aopId: drunkWineFields.aopId.nullable().optional(),
	vintage: drunkWineFields.vintage.nullable().optional(),
	grapeVarietyIds: drunkWineFields.grapeVarietyIds.optional(),
	producer: drunkWineFields.producer.nullable().optional(),
	price: drunkWineFields.price.nullable().optional(),
});

export const updateWineTastingInput = z.object({
	id: z.string().min(1).max(80),
	drankOn: wineTastingFields.drankOn.nullable().optional(),
	rating: wineTastingFields.rating.nullable().optional(),
	memo: wineTastingFields.memo.nullable().optional(),
});

// 上の2つは手書きのミラーなので、値スキーマへフィールドを足してここへ足し忘れても
// 実行時には何も起きない。Record への代入は「全キーが揃っていること」を要求するので、
// 足し忘れがコンパイルエラーになる(推論された値の型はそのまま保たれる)。
// 値の nullable 有無は fields.ts の clear 規約が単一情報源で、突合は fields.test.ts。
const _updateCoversDrunkWineFields: Record<
	keyof typeof drunkWineFields | "id",
	unknown
> = updateDrunkWineInput.shape;
const _updateCoversTastingFields: Record<
	keyof typeof wineTastingFields | "id",
	unknown
> = updateWineTastingInput.shape;
void _updateCoversDrunkWineFields;
void _updateCoversTastingFields;

export type CreateDrunkWineInput = z.infer<typeof createDrunkWineInput>;
export type UpdateDrunkWineInput = z.infer<typeof updateDrunkWineInput>;
export type CreateWineTastingInput = z.infer<typeof createWineTastingInput>;
export type UpdateWineTastingInput = z.infer<typeof updateWineTastingInput>;
