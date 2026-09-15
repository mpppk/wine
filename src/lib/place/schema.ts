import { z } from "zod";
import { calendarDateSchema } from "#/lib/date/calendar-date";
import { drunkWineReferenceInputs } from "#/lib/drunk-wine/reference-inputs";
import {
	createDrunkWineInput,
	PRICE_MAX,
	PRICE_MIN,
	wineTastingFields,
} from "#/lib/drunk-wine/schema";
import { PLACE_KIND_IDS } from "./place";

// 場所(place)と目撃記録(wine_sighting)の入力バリデーション。Web の server fn と
// MCP ツールの両方から使うため、ランタイム依存(DB/R2)を持たない純粋な zod パーツに
// 保つ(drunk-wine/schema.ts と同じ方針)。
//
// 目撃記録は「所有状態 ⊥ 飲用履歴」の直交2軸(#195)に足す第3の 1:N 軸(Issue #358)。
// 同じワインを複数の店で見かけたら 1 エントリ + 目撃記録 × N になる。

// フィールドの数値・文字数の上限。zod と UI で同じ値を使うためここを単一情報源に
// する(docs/architecture.md「上限値などの数値定数はドメイン lib に置き…」)。
export const PLACE_NAME_MAX = 100;
export const PLACE_MEMO_MAX = 500;
export const SIGHTING_MEMO_MAX = 1000;

/**
 * 一括登録1回で解析にかける写真の上限。エントリ1件のボトル写真の上限
 * (MAX_PHOTOS_PER_ENTRY = 6)とは別物なので使い回さない。こちらは
 * 「1回の解析でAIに渡す枚数」で、クレジット消費と出力の切り詰まり(truncated)に
 * 直結する。
 */
export const MAX_PHOTOS_PER_IMPORT_BATCH = 10;

/** 場所(ユーザ単位のマスタ)の属性 */
const placeFields = {
	name: z.string().trim().min(1).max(PLACE_NAME_MAX),
	// 未指定は DEFAULT_PLACE_KIND(other)としてサービス層が埋める
	kind: z.enum(PLACE_KIND_IDS).optional(),
	memo: z.string().max(PLACE_MEMO_MAX).optional(),
};

/**
 * 目撃記録(1銘柄に複数持てる)。
 *
 * placeId / batchId / photoIndex / photoIndexes は「どこで・どの写真で見かけたか」の
 * 由来情報で、すべて任意。場所を入力せずに見かけた記録だけ残せるようにする(入力の強制は
 * 一括登録のUXを重くするだけで、記録の価値を落とさないため)。
 */
export const wineSightingFields = {
	placeId: z.string().min(1).max(80).optional(),
	batchId: z.string().min(1).max(80).optional(),
	/** バッチ内の何枚目の写真で見かけたか(0始まり) */
	photoIndex: z
		.number()
		.int()
		.min(0)
		.max(MAX_PHOTOS_PER_IMPORT_BATCH - 1)
		.optional(),
	/**
	 * そのワインが写っていたバッチ写真の番号の一覧(#574)。AIの画像-ワイン対応
	 * (`photoIndexes`)を登録まで持ち回るためのもので、`photoIndex`(先頭1枚の
	 * 後方互換)と併存する。銘柄の写真の取得元にもなる
	 * (`adoptBatchPhotosForWines` が対応写真をすべて複製する)。
	 */
	photoIndexes: z
		.array(
			z
				.number()
				.int()
				.min(0)
				.max(MAX_PHOTOS_PER_IMPORT_BATCH - 1),
		)
		.max(MAX_PHOTOS_PER_IMPORT_BATCH)
		.optional(),
	/** 見かけた日 "YYYY-MM-DD"。覚えていない場合は未指定 */
	seenOn: calendarDateSchema.optional(),
	// 価格は銘柄(drunk_wine.price)にもあるが、こちらは「その店での売値」。
	// 店ごとに違うのが当たり前なので目撃記録側に持つ。
	price: z.number().int().min(PRICE_MIN).max(PRICE_MAX).optional(),
	memo: z.string().max(SIGHTING_MEMO_MAX).optional(),
};

export const createPlaceInput = z.object(placeFields);

// 更新は id のみ必須、他は「指定されたフィールドだけ差し替え」。
// null は「クリアする」の意(optional = 未指定は変更しない)。
export const updatePlaceInput = z.object({
	id: z.string().min(1).max(80),
	name: placeFields.name.optional(),
	// NOT NULL 列なのでクリア不可
	kind: placeFields.kind,
	memo: placeFields.memo.nullable().optional(),
});

/**
 * 場所は「既存の選択」と「その場で新規作成」の排他。目撃記録を作る/更新する入力が
 * すべて同じ規則を共有するための述語(片方だけ緩めると経路ごとに挙動がずれる)。
 */
const placeChoiceIsExclusive = (v: {
	placeId?: string | null;
	newPlace?: unknown;
}) => !(v.placeId && v.newPlace);

const PLACE_CHOICE_ERROR = {
	error: "場所は既存の選択か新規作成のどちらか一方にしてください",
} as const;

/**
 * 目撃記録の追加(既存の銘柄に足す)。`newPlace` で**その場の場所の新規作成**も受ける。
 * 編集画面の「見かけた記録」から場所を作れないと、銘柄の登録時に場所を入れ損ねた
 * 利用者は既存の場所からしか選べない。作成は同じ db.batch で原子的に行う。
 */
export const createWineSightingInput = z
	.object({ ...wineSightingFields, newPlace: createPlaceInput.optional() })
	.refine(placeChoiceIsExclusive, PLACE_CHOICE_ERROR);

/**
 * 銘柄の新規作成に添える目撃記録(Issue #495)。
 *
 * `createWineSightingInput` と分けるのは**由来の列(batchId / photoIndex)を持たない**
 * ため。この経路にバッチは無く、写真は銘柄側(drunk_wine.photo_keys)に付く。
 *
 * 場所は一括登録と同じく「既存の選択」と「その場で新規作成」の排他にする。写真1本ぶんの
 * 登録しか通らない利用者(1本のエチケットを撮った回)がここで場所を作れないと、
 * 場所は一括登録を経由しないと永久に作れない——`/cellar/import` が `/cellar/new` へ
 * 転送されるようになった今、単体登録は一括登録の下位経路ではないため。
 */
const createEntrySightingInput = z
	.object({
		placeId: wineSightingFields.placeId,
		newPlace: createPlaceInput.optional(),
		seenOn: wineSightingFields.seenOn,
		price: wineSightingFields.price,
		memo: wineSightingFields.memo,
	})
	.refine(placeChoiceIsExclusive, PLACE_CHOICE_ERROR);

/**
 * 目撃記録の更新。`newPlace` を指定すると場所を作ってその記録に紐付ける。
 * `placeId` との排他は追加時と同じ規則で、`newPlace` を送るときは `placeId` を
 * 省く(サーバが採番した新しい id を入れる)。
 */
export const updateWineSightingInput = z
	.object({
		id: z.string().min(1).max(80),
		placeId: wineSightingFields.placeId.nullable().optional(),
		newPlace: createPlaceInput.optional(),
		batchId: wineSightingFields.batchId.nullable().optional(),
		photoIndex: wineSightingFields.photoIndex.nullable().optional(),
		photoIndexes: wineSightingFields.photoIndexes.nullable().optional(),
		seenOn: wineSightingFields.seenOn.nullable().optional(),
		price: wineSightingFields.price.nullable().optional(),
		memo: wineSightingFields.memo.nullable().optional(),
	})
	.refine(placeChoiceIsExclusive, PLACE_CHOICE_ERROR);

// 上の2つは手書きのミラーなので、値スキーマへフィールドを足してここへ足し忘れても
// 実行時には何も起きない。Record への代入は「全キーが揃っていること」を要求するので、
// 足し忘れがコンパイルエラーになる(drunk-wine/schema.ts と同じイディオム)。
const _updateCoversPlaceFields: Record<
	keyof typeof placeFields | "id",
	unknown
> = updatePlaceInput.shape;
const _updateCoversSightingFields: Record<
	keyof typeof wineSightingFields | "id",
	unknown
> = updateWineSightingInput.shape;
void _updateCoversPlaceFields;
void _updateCoversSightingFields;

/**
 * 体験記録(wine_encounter)の入力バリデーション(Issue #606)。
 *
 * 旧 wineTastingFields(飲用)と wineSightingFields(目撃)を1つに統合したもの。
 * place と wine_encounter が同じ入力に同居するため、循環 import を避ける配置は
 * place/schema.ts 側に寄せる現状の判断を踏襲する(createDrunkWineWithSightingInput
 * と同じ理由)。旧2つのフィールド定義は互換アダプタ(server fn・MCP)が使うため残す。
 *
 * memo の上限は飲用側の 2000 を採る(目撃側の 1000 では、移送された飲用メモの
 * 編集が「長すぎる」で弾かれてしまうため)。
 */
export const wineEncounterFields = {
	/** この回に飲んだか */
	drank: z.boolean(),
	/** 出会った日 "YYYY-MM-DD"。覚えていない場合は未指定 */
	occurredOn: calendarDateSchema.optional(),
	/** 1–5。drank=1 のときだけ意味を持つ */
	rating: wineTastingFields.rating,
	// 価格は「その場での売値」。店ごとに違うのが当たり前なので体験記録側に持つ
	price: wineSightingFields.price,
	memo: wineTastingFields.memo,
	placeId: wineSightingFields.placeId,
	batchId: wineSightingFields.batchId,
	/** バッチ内の何枚目の写真で出会ったか(0始まり) */
	photoIndex: wineSightingFields.photoIndex,
	/**
	 * そのワインが写っていたバッチ写真の番号の一覧(#574)。`photoIndex`(先頭1枚の
	 * 後方互換)と併存する。
	 */
	photoIndexes: wineSightingFields.photoIndexes,
};

/**
 * 体験記録の追加。`newPlace` で**その場の場所の新規作成**も受ける。
 * 場所は「既存の選択」と「その場で新規作成」の排他(createWineSightingInput と同じ規則)。
 */
export const createWineEncounterInput = z
	.object({ ...wineEncounterFields, newPlace: createPlaceInput.optional() })
	.refine(placeChoiceIsExclusive, PLACE_CHOICE_ERROR);

/**
 * 体験記録の更新。`newPlace` を指定すると場所を作ってその記録に紐付ける。
 *
 * drank は更新対象に含めない(旧 updateWineTasting / updateWineSighting が
 * 「飲用/目撃であること」を変えなかったのと同じく、体験の種類は作り直しで変える)。
 */
export const updateWineEncounterInput = z
	.object({
		id: z.string().min(1).max(80),
		occurredOn: wineEncounterFields.occurredOn.nullable().optional(),
		rating: wineEncounterFields.rating.nullable().optional(),
		price: wineEncounterFields.price.nullable().optional(),
		memo: wineEncounterFields.memo.nullable().optional(),
		placeId: wineEncounterFields.placeId.nullable().optional(),
		newPlace: createPlaceInput.optional(),
		batchId: wineEncounterFields.batchId.nullable().optional(),
		photoIndex: wineEncounterFields.photoIndex.nullable().optional(),
		photoIndexes: wineEncounterFields.photoIndexes.nullable().optional(),
	})
	.refine(placeChoiceIsExclusive, PLACE_CHOICE_ERROR);

const _updateCoversEncounterFields: Record<
	keyof Omit<typeof wineEncounterFields, "drank"> | "id",
	unknown
> = updateWineEncounterInput.shape;
void _updateCoversEncounterFields;

/**
 * 銘柄 + 飲用記録 + 目撃記録をまとめて作る入力(#495)。
 *
 * **`createDrunkWineInput` の隣(drunk-wine/schema.ts)には置けない**。目撃記録の
 * フィールド定義はこのファイルにあり、こちらは PRICE_MIN/MAX を drunk-wine/schema から
 * 取っているので、逆向きに import すると循環する。両方を必要とする合成は import する
 * 側に置く(一括登録の `import-batch/schema.ts` が第3のモジュールとして両方を
 * import しているのと同じ形)。
 */
export const createDrunkWineWithSightingInput = createDrunkWineInput.extend({
	sighting: createEntrySightingInput.optional(),
	// 解析の参考サイト・市場価格。銘柄に属する参考情報で、そのまま保存する。
	// 形の定義は `drunkWineReferenceInputs` が単一情報源(一括登録と共有する)。
	...drunkWineReferenceInputs,
});

export type CreatePlaceInput = z.infer<typeof createPlaceInput>;
export type UpdatePlaceInput = z.infer<typeof updatePlaceInput>;
export type CreateWineSightingInput = z.infer<typeof createWineSightingInput>;
export type UpdateWineSightingInput = z.infer<typeof updateWineSightingInput>;
export type CreateWineEncounterInput = z.infer<typeof createWineEncounterInput>;
export type UpdateWineEncounterInput = z.infer<typeof updateWineEncounterInput>;
export type CreateEntrySightingInput = z.infer<typeof createEntrySightingInput>;
export type CreateDrunkWineWithSightingInput = z.infer<
	typeof createDrunkWineWithSightingInput
>;
