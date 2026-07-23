import {
	PRICE_MAX,
	PRICE_MIN,
	RATING_MAX,
	RATING_MIN,
	VINTAGE_MAX,
	VINTAGE_MIN,
} from "./schema";

// 飲んだワイン編集フォームの「表示 + 差分パッチ規約」の単一情報源。
// 値のバリデーション自体は drunkWineFields(schema.ts)が単一情報源で、ここは
// その上に載る「フォームでの見せ方」と「更新時のクリア規約」を1箇所にまとめる。
//
// Web の DrunkWineForm と MCP App(apps.ts のテンプレート文字列内 vanilla JS)が
// フィールド一覧とパッチ規約を各自ハードコードしてドリフトしていた(#155)。
// apps.ts はこの定義を JSON 埋め込みして render()/collectPatch() を汎用ループ化する。
// そのため本モジュールはランタイム非依存に保つ(cloudflare:workers を import しない)。

export type DrunkWineInputKind =
	| "text"
	| "date"
	| "number"
	| "rating"
	| "textarea"
	| "grape"
	| "aop";

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

// 配列の順序＝App フォームの描画順。half の隣接ペアが現行の
// 「飲んだ日/評価」「ヴィンテージ/価格」の2カラム行を再現する。
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
		camelKey: "drankOn",
		snakeKey: "drank_on",
		label: "飲んだ日",
		input: "date",
		clear: "null",
		col: "half",
	},
	{
		camelKey: "rating",
		snakeKey: "rating",
		label: "評価",
		input: "rating",
		clear: "null",
		col: "half",
		min: RATING_MIN,
		max: RATING_MAX,
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
	{
		camelKey: "grapeVarietyIds",
		snakeKey: "grape_variety_ids",
		label: "ぶどう品種",
		input: "grape",
		clear: "emptyArray",
		col: "full",
	},
	{
		camelKey: "memo",
		snakeKey: "memo",
		label: "メモ",
		input: "textarea",
		clear: "null",
		col: "full",
	},
] as const satisfies readonly DrunkWineFieldDef[];

export type DrunkWineCamelKey =
	(typeof DRUNK_WINE_FIELD_DEFS)[number]["camelKey"];
export type DrunkWineSnakeKey =
	(typeof DRUNK_WINE_FIELD_DEFS)[number]["snakeKey"];

// apps.ts がサンドボックス iframe のテンプレート文字列へ JSON 埋め込みする
// クライアント安全な射影(zod 非依存の素データ)。camelKey は App では使わない。
// undefined のプロパティは JSON.stringify で自然に落ちる。
export interface ClientFieldDef {
	snakeKey: string;
	label: string;
	input: DrunkWineInputKind;
	clear: ClearConvention;
	col: "full" | "half";
	min?: number;
	max?: number;
	placeholder?: string;
	required?: boolean;
}

export function clientFieldDefs(): ClientFieldDef[] {
	return DRUNK_WINE_FIELD_DEFS.map((d) => ({
		snakeKey: d.snakeKey,
		label: d.label,
		input: d.input,
		clear: d.clear,
		col: d.col,
		min: "min" in d ? d.min : undefined,
		max: "max" in d ? d.max : undefined,
		placeholder: "placeholder" in d ? d.placeholder : undefined,
		required: "required" in d ? d.required : undefined,
	}));
}

// フォーム入力値。grape は選択中IDの配列、それ以外は input.value 相当の文字列。
// キーは snakeKey。
export type DrunkWineFormValues = Record<string, string | string[]>;

export type DrunkWinePatch = Record<string, string | number | string[] | null>;

// 差分パッチ規約の唯一のテスト可能な実装。apps.ts のテンプレート文字列内 JS は
// (サンドボックスから TS を実行時 import できないため)このロジックを
// near-verbatim にミラーする汎用ループを持つ。規約は fields.test.ts が固定する。
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
			// name: 空 or 未変更なら送らない(必須なのでクリア不可)
			const curName = (entry[key] as string | undefined) ?? "";
			if (v && v !== curName) patch[key] = v;
			continue;
		}

		if (def.input === "number" || def.input === "rating") {
			const num = v === "" ? null : Number(v);
			const cur = (entry[key] ?? null) as number | null;
			if (num !== cur) patch[key] = num;
			continue;
		}

		// text / date / textarea / aop: 空欄への変更は null(クリア)として送る
		const cur = (entry[key] as string | undefined) ?? "";
		if (v !== cur) patch[key] = v === "" ? null : v;
	}
	return patch;
}
