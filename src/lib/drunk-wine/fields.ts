import type { CreateDrunkWineInput, UpdateDrunkWineInput } from "./schema";
import { PRICE_MAX, PRICE_MIN, VINTAGE_MAX, VINTAGE_MIN } from "./schema";

// マイセラーの銘柄編集フォームの「表示 + 差分パッチ規約」の単一情報源。
// 値のバリデーション自体は drunkWineFields(schema.ts)が単一情報源で、ここは
// その上に載る「フォームでの見せ方」と「更新時のクリア規約」を1箇所にまとめる。
//
// Web の DrunkWineForm と MCP App(apps.ts のテンプレート文字列内 vanilla JS)が
// フィールド一覧とパッチ規約を各自ハードコードしてドリフトしていた(#155)。現在は
// MCP App も実 React 実装(/embed/drunk-wine)になり、両者がこの定義と
// collectDrunkWinePatch を直接 import する(#189)。MCPツールの入力スキーマ
// (schemas.ts)も同じ定義から生成するため、本モジュールはランタイム非依存に保つ
// (cloudflare:workers を import しない)。

export type DrunkWineInputKind =
	| "text"
	// 複数行のテキスト。差分パッチ規約は "text" と同じ(空欄→null)で、
	// 違うのは描画に使う要素だけ(input か textarea か)。
	| "textarea"
	| "select"
	| "number"
	| "grape"
	| "aop"
	| "region"
	| "country";

// 更新時に「空欄にしたら何を送るか」。
// - "null": 空欄→null でクリア(大半のフィールド)
// - "emptyArray": 空(全解除)→[] でクリア(品種)
// - "never": クリア不可(name。空/未変更なら送らない)
export type ClearConvention = "null" | "emptyArray" | "never";

export interface DrunkWineFieldDef {
	// 値スキーマ(drunkWineFields)・サービス層の camelCase キー。値スキーマとの
	// キー集合一致は fields.test.ts が実行時に突合し、フィールドの追加漏れ・
	// タイポ・削除漏れを検出する(値の単一情報源は drunkWineFields のまま)。
	camelKey: string;
	// MCP 境界(snake_case)と App の entry オブジェクトのキー、フォームの DOM id 接尾辞。
	snakeKey: string;
	label: string;
	input: DrunkWineInputKind;
	clear: ClearConvention;
	// App フォームの配置ヒント。"half" が隣接すると1行(2カラム)にまとまる。
	col: "full" | "half";
	min?: number;
	max?: number;
	placeholder?: string;
	required?: boolean;
}

// 配列の順序＝App フォームの描画順。half の隣接ペアが「ヴィンテージ/価格」の
// 2カラム行を再現する。
//
// 飲んだ日・評価・メモはここに無い。「同じワインを複数回飲む」を扱うため
// wine_tasting(1:N)へ移した(Issue #195)。MCP の後方互換引数としては
// WINE_TASTING_FIELDS 側で扱う。
export const DRUNK_WINE_FIELD_DEFS = [
	{
		camelKey: "name",
		snakeKey: "name",
		label: "名前",
		input: "text",
		clear: "never",
		col: "full",
		required: true,
	},
	{
		camelKey: "status",
		snakeKey: "status",
		label: "状態",
		input: "select",
		// NOT NULL 列。空欄でのクリアは無く、変わったときだけ送る
		clear: "never",
		col: "half",
	},
	{
		camelKey: "vintage",
		snakeKey: "vintage",
		label: "ヴィンテージ",
		input: "number",
		clear: "null",
		col: "half",
		min: VINTAGE_MIN,
		max: VINTAGE_MAX,
	},
	{
		camelKey: "price",
		snakeKey: "price",
		label: "価格 (円)",
		input: "number",
		clear: "null",
		col: "half",
		min: PRICE_MIN,
		max: PRICE_MAX,
	},
	{
		camelKey: "producer",
		snakeKey: "producer",
		label: "生産者",
		input: "text",
		clear: "null",
		col: "full",
	},
	{
		camelKey: "aopId",
		snakeKey: "aop_id",
		label: "AOP",
		input: "aop",
		clear: "null",
		col: "full",
		placeholder: "list_aopsのid (例: gevrey-chambertin)",
	},
	// 産地の粗い紐付け(AOPまで特定できない場合)。aop_id とあわせて「最も細かい
	// 1つだけを保存する」排他で、正規化はサービス層(applyProvenanceExclusivity)。
	{
		camelKey: "regionId",
		snakeKey: "region_id",
		label: "地域",
		input: "region",
		clear: "null",
		col: "full",
		placeholder: "list_wine_regionsのid (例: bourgogne)",
	},
	{
		camelKey: "countryId",
		snakeKey: "country_id",
		label: "国",
		input: "country",
		clear: "null",
		col: "full",
		placeholder: "国のid (france / italy)",
	},
	{
		camelKey: "grapeVarietyIds",
		snakeKey: "grape_variety_ids",
		label: "ぶどう品種",
		input: "grape",
		clear: "emptyArray",
		col: "full",
	},
	// 銘柄についてのコメント(#471)。解析が香り・味わい・生産者の説明を書き込み、
	// 利用者が編集できる。飲用記録のメモ(WINE_TASTING_FIELDS)とは別物。
	{
		camelKey: "note",
		snakeKey: "note",
		label: "コメント",
		input: "textarea",
		clear: "null",
		col: "full",
		placeholder: "香り・味わい・生産者について",
	},
] as const satisfies readonly DrunkWineFieldDef[];

// 飲用記録(wine_tasting)のフィールド。銘柄の DRUNK_WINE_FIELD_DEFS とは別に持つ:
// 1:N は「1エントリ=1レコード」前提の差分パッチ規約(collectDrunkWinePatch)では
// 構造的に表現できない(どの飲用記録への差分かを表せない)ため。
// ここは MCP のレガシー引数(register/update の drank_on/rating/memo)と MCP App の
// patch が使う snake↔camel 対応の単一情報源。
export const WINE_TASTING_FIELDS = [
	{ camelKey: "drankOn", snakeKey: "drank_on", label: "飲んだ日" },
	{ camelKey: "rating", snakeKey: "rating", label: "評価" },
	{ camelKey: "memo", snakeKey: "memo", label: "メモ" },
] as const;

export type WineTastingCamelKey =
	(typeof WINE_TASTING_FIELDS)[number]["camelKey"];
export type WineTastingSnakeKey =
	(typeof WINE_TASTING_FIELDS)[number]["snakeKey"];

export type DrunkWineCamelKey =
	(typeof DRUNK_WINE_FIELD_DEFS)[number]["camelKey"];
export type DrunkWineSnakeKey =
	(typeof DRUNK_WINE_FIELD_DEFS)[number]["snakeKey"];

// フォーム入力値。grape は選択中IDの配列、それ以外は input.value 相当の文字列。
// キーは snakeKey。
export type DrunkWineFormValues = Record<string, string | string[]>;

export type DrunkWinePatch = Record<string, string | number | string[] | null>;

// MCP 境界(snake_case)の書き込みツール引数の型。update/register ハンドラの args と
// toCamelPatch の入力に使う。値スキーマの clear 規約から型を導出する:
// clear:"null" のフィールドだけ null 許容、grape は string[]、数値系は number。
// 全フィールド optional(register の name は上位スキーマで非 optional に絞られる)。
export type DrunkWineFieldArgs = {
	[D in (typeof DRUNK_WINE_FIELD_DEFS)[number] as D["snakeKey"]]?: D["input"] extends "grape"
		? string[]
		: D["input"] extends "number"
			? D["clear"] extends "null"
				? number | null
				: number
			: D["clear"] extends "null"
				? string | null
				: string;
};

// 差分パッチ規約の唯一の実装。Web版フォームも MCP App のフォームもこれを
// 直接呼ぶ(ミラー実装は無い)。規約は fields.test.ts が固定する。
//
// 規約: 未変更フィールドは送らない / 空欄は clear 規約に従う(null or []) /
// name はクリア不可 / number は Number() / grape は順序非依存で比較。
export function collectDrunkWinePatch(
	entry: Record<string, unknown>,
	values: DrunkWineFormValues,
): DrunkWinePatch {
	const patch: DrunkWinePatch = {};
	for (const def of DRUNK_WINE_FIELD_DEFS) {
		const key = def.snakeKey;
		const raw = values[key];

		if (def.input === "grape") {
			const ids = Array.isArray(raw) ? raw : [];
			const cur = ((entry[key] as string[] | undefined) ?? [])
				.slice()
				.sort()
				.join(",");
			if (ids.slice().sort().join(",") !== cur) patch[key] = ids; // [] でクリア
			continue;
		}

		const v = (typeof raw === "string" ? raw : "").trim();

		if (def.clear === "never") {
			// name / status: 空 or 未変更なら送らない(クリア不可。status は NOT NULL 列で
			// select が常に非空値を返すため、この分岐が null 送出を構造的に防ぐ)
			const curName = (entry[key] as string | undefined) ?? "";
			if (v && v !== curName) patch[key] = v;
			continue;
		}

		if (def.input === "number") {
			const num = v === "" ? null : Number(v);
			const cur = (entry[key] ?? null) as number | null;
			if (num !== cur) patch[key] = num;
			continue;
		}

		// text / aop: 空欄への変更は null(クリア)として送る
		const cur = (entry[key] as string | undefined) ?? "";
		if (v !== cur) patch[key] = v === "" ? null : v;
	}
	return patch;
}

// ---- 境界のキー射影 -------------------------------------------------------
// サービス層(camelCase)と MCP/フォーム(snake_case)の対応も DRUNK_WINE_FIELD_DEFS
// から導出する。値は変換せず、キーの読み替えだけを行う。

/** camelCase のエントリ(DrunkWineEntry 等)を受ける構造型。定義外のキーは無視される。 */
export type DrunkWineCamelEntry = { [K in DrunkWineCamelKey]?: unknown };

/** snakeKey keyed のパッチ。DrunkWinePatch も DrunkWineFieldArgs もこれに代入できる。 */
export type DrunkWineSnakePatch = {
	[K in DrunkWineSnakeKey]?: string | number | string[] | null;
};

/**
 * camelCase のエントリを snakeKey keyed へ射影する(collectDrunkWinePatch の
 * 第1引数用)。aopNameJa / regionId / photoUrls / updatedAt などフィールド定義に
 * 無いキーは落ちるので、差分の基準として過不足のない形になる。
 */
export function toSnakeEntry(
	entry: DrunkWineCamelEntry,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const d of DRUNK_WINE_FIELD_DEFS) {
		out[d.snakeKey] = (entry as Record<string, unknown>)[d.camelKey];
	}
	return out;
}

/**
 * 差分パッチの基準(entry)から、導出された粗い産地キーを落とす。
 *
 * サーバが返すエントリの region_id / country_id は「保存値または細かい単位からの
 * 導出値」で、AOP紐付けのエントリでも非nullになる。これをそのまま
 * collectDrunkWinePatch の基準にすると、フォーム(最も細かい1つだけを保持)との
 * 差分で region_id: null が毎回送られ、「未変更なのに更新が飛ぶ」ことになる。
 * 排他の不変条件(aop_id があれば粗い2列はDB上 NULL)を基準側にも適用して防ぐ。
 */
export function stripDerivedProvenance(
	entry: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...entry };
	if (out.aop_id) {
		out.region_id = undefined;
		out.country_id = undefined;
	} else if (out.region_id) {
		out.country_id = undefined;
	}
	return out;
}

// 値の型は検証されないキャストを伴うため、変換の実体はこの1関数に閉じて
// 呼び出し側(フォーム・MCPツール)にキャストを散らさない。
function toCamelKeyed(patch: DrunkWineSnakePatch): Record<string, unknown> {
	const source = patch as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const d of DRUNK_WINE_FIELD_DEFS) {
		// 未指定(キーが無い/undefined)は「変更しない」。サービス層は各キーを
		// 明示的に読むので、キーごと落としても undefined を入れても等価。
		if (source[d.snakeKey] !== undefined) out[d.camelKey] = source[d.snakeKey];
	}
	return out;
}

/** snakeKey パッチ → 更新入力(camelCase)。null は「クリア」としてそのまま渡す。 */
export function toCamelPatch(
	patch: DrunkWineSnakePatch,
): Omit<UpdateDrunkWineInput, "id"> {
	return toCamelKeyed(patch) as Omit<UpdateDrunkWineInput, "id">;
}

/**
 * snakeKey パッチ → 作成入力(camelCase)。
 * 空エントリ({})を基準に collectDrunkWinePatch を通したパッチには null が現れない
 * (クリアすべき既存値が無いため空欄はキーごと落ちる)ので、そのまま作成入力にできる。
 * name は必須なので呼び出し側が明示的に足す。
 */
export function toCamelCreateFields(
	patch: DrunkWineSnakePatch,
): Omit<CreateDrunkWineInput, "name"> {
	return toCamelKeyed(patch) as Omit<CreateDrunkWineInput, "name">;
}

/**
 * 送るべき変更があるか。全キーが未指定のパッチで UPDATE を発行すると
 * 空 SET になるため、呼び出し側はこれでガードする。
 * null(クリア)は「変更あり」として扱う。
 */
export function hasDrunkWinePatch(patch: Record<string, unknown>): boolean {
	return Object.values(patch).some((v) => v !== undefined);
}

// ---- 飲用記録 -------------------------------------------------------------
// 銘柄と同じ差分規約(未変更は送らない / 空欄は null でクリア / rating は Number)を
// 飲用記録にも適用する。MCP App のフォームがレガシー引数を組み立てるのに使う。

export type WineTastingFormValues = Record<string, string>;

export type WineTastingPatch = Record<string, string | number | null>;

/** snakeKey keyed の飲用記録パッチ。MCP のレガシー引数もこの形。 */
export type WineTastingSnakePatch = {
	[K in WineTastingSnakeKey]?: string | number | null;
};

export function collectWineTastingPatch(
	entry: Record<string, unknown>,
	values: WineTastingFormValues,
): WineTastingPatch {
	const patch: WineTastingPatch = {};
	for (const def of WINE_TASTING_FIELDS) {
		const key = def.snakeKey;
		const v = (values[key] ?? "").trim();

		if (def.camelKey === "rating") {
			const num = v === "" ? null : Number(v);
			const cur = (entry[key] ?? null) as number | null;
			if (num !== cur) patch[key] = num;
			continue;
		}

		const cur = (entry[key] as string | undefined) ?? "";
		if (v !== cur) patch[key] = v === "" ? null : v;
	}
	return patch;
}

/** snakeKey パッチ → camelCase。null は「その列をクリア」の意でそのまま渡す。 */
export function toCamelTastingPatch(
	patch: WineTastingSnakePatch,
): Record<WineTastingCamelKey, string | number | null | undefined> {
	const source = patch as Record<string, string | number | null | undefined>;
	const out = {} as Record<
		WineTastingCamelKey,
		string | number | null | undefined
	>;
	for (const d of WINE_TASTING_FIELDS) {
		if (source[d.snakeKey] !== undefined) out[d.camelKey] = source[d.snakeKey];
	}
	return out;
}
