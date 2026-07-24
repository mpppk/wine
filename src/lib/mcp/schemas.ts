import { z } from "zod";
import { AI_MAX_QUESTION_CHARS, REGION_QA_MODEL_KEYS } from "#/lib/ai/config";
import {
	DRUNK_WINE_FIELD_DEFS,
	type DrunkWineSnakeKey,
} from "#/lib/drunk-wine/fields";
import { drunkWineFields } from "#/lib/drunk-wine/schema";
import { AOP_TAG_IDS } from "#/lib/wine/tags";

// MCPツールの入力スキーマ。DB/ランタイム依存を持たせず、vitest(jsdom)で
// ユニットテストできる形に保つ。McpServer.registerTool の inputSchema には
// zod の raw shape オブジェクトをそのまま渡す。

export const listAopsInput = {
	region_id: z
		.string()
		.describe("地域ID (list_wine_regions の id。例: 'bourgogne')"),
	grape_variety_id: z
		.string()
		.optional()
		.describe(
			"ブドウ品種ID (list_grape_varieties の id。例: 'pinot-noir')。" +
				"指定するとその品種の使用が許可されているAOPのみ返す。",
		),
	kind: z
		.enum(["regional", "village", "vineyard", "winery"])
		.optional()
		.describe("区分で絞り込む (地方名/村名/畑/ワイナリー)"),
	tags: z
		.array(z.enum(AOP_TAG_IDS))
		.optional()
		.describe(
			"格付けタグで絞り込む(複数指定はOR)。" +
				"ブルゴーニュ/シャンパーニュ: grand-cru=特級, premier-cru=一級" +
				"(村に premier-cru が付く場合、シャンパーニュでは村自体が一級、" +
				"ブルゴーニュ等では村名AOC内に1er Cru区画があることを表す)。" +
				"ボルドー: *-cru-classe-1855 はメドック/ソーテルヌ1855年格付け" +
				"(第1〜5級・特別第1級)、premier-grand-cru-classe-a/b は" +
				"サンテミリオン第1特別級A/B。" +
				"イタリア: docg=DOCG, doc=DOC。",
		),
};

export const getAopInput = {
	aop_id: z
		.string()
		.describe("AOPのID (list_aops の id。例: 'gevrey-chambertin')"),
};

// 地域チャットQ&A。Workers AI で回答し、ユーザのAIクレジットを消費する。
// マルチターンにしたい場合は history に直前までの往復を渡す(サーバは保持しない)。
export const askRegionInput = {
	region_id: z
		.string()
		.describe("質問対象の地域ID (list_wine_regions の id。例: 'bourgogne')"),
	aop_id: z
		.string()
		.optional()
		.describe(
			"注目するAOPのID (list_aops の id。指定すると回答の文脈に含める)",
		),
	question: z
		.string()
		.trim()
		.min(1)
		.max(AI_MAX_QUESTION_CHARS)
		.describe("地域・AOPについての質問(日本語)"),
	history: z
		.array(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string().min(1).max(4000),
			}),
		)
		.max(20)
		.optional()
		.describe("会話を継続する場合の直前までの履歴(古い順)。省略時は単発質問"),
	model: z
		.enum(REGION_QA_MODEL_KEYS)
		.optional()
		.describe(
			"回答に使うモデルの明示指定 (gemma4 か llama4)。省略時はユーザのプロフィール設定を使う",
		),
};

export const showAopMapInput = {
	region_id: z
		.string()
		.describe("地図を表示する地域ID (list_wine_regions の id)"),
	grape_variety_id: z
		.string()
		.optional()
		.describe(
			"ブドウ品種ID。指定するとその品種が許可されたAOPをハイライトした地図になる。",
		),
	aop_id: z.string().optional().describe("最初に選択状態にするAOPのID"),
};

// 飲んだワイン(マイセラー)の書き込みツール入力。バリデーション本体は
// Webのserver fnと共通の drunkWineFields を再利用し、フィールド一覧・snake_case
// キー・クリア規約(nullable の有無)は単一情報源 DRUNK_WINE_FIELD_DEFS から生成する。
// MCP 固有の日本語 describe だけは下の型付きマップに集約する(フィールドを足すと
// 未記入がコンパイルエラーになる)。

const photoBase64 = z
	.string()
	.max(7_100_000)
	.optional()
	.describe("ボトル写真のbase64。デコード後5MBまで");
const photoMimeType = z
	.enum(["image/jpeg", "image/png", "image/webp", "image/gif"])
	.optional()
	.describe("写真のMIMEタイプ (photo_base64 指定時は必須)");

const REGISTER_DESCRIBE: Record<DrunkWineSnakeKey, string> = {
	name: "ワイン名(ラベル表記。必須)",
	drank_on: "飲んだ日 (YYYY-MM-DD)",
	rating: "評価 (1〜5の整数)",
	vintage: "ヴィンテージ (1800〜2100の年)",
	price: "価格 (円)",
	producer: "生産者名 (200文字まで)",
	aop_id: "紐付けるAOPのID (list_aopsのid。任意)",
	grape_variety_ids: "ぶどう品種ID (list_grape_varietiesのid。最大20件)",
	memo: "メモ・感想 (2000文字まで)",
};

// null クリア可のフィールドは「。nullでクリア」、品種は「。[]でクリア」を付す。
// name はクリア不可なので付けない。
const UPDATE_DESCRIBE: Record<DrunkWineSnakeKey, string> = {
	name: "ワイン名(ラベル表記)",
	drank_on: "飲んだ日 (YYYY-MM-DD)。nullでクリア",
	rating: "評価 (1〜5の整数)。nullでクリア",
	vintage: "ヴィンテージ (1800〜2100の年)。nullでクリア",
	price: "価格 (円)。nullでクリア",
	producer: "生産者名 (200文字まで)。nullでクリア",
	aop_id: "紐付けるAOPのID (list_aopsのid)。nullでクリア",
	grape_variety_ids:
		"ぶどう品種ID (list_grape_varietiesのid。最大20件)。[]でクリア",
	memo: "メモ・感想 (2000文字まで)。nullでクリア",
};

// DRUNK_WINE_FIELD_DEFS を走査して MCP の raw shape を生成する。
// drunkWineFields[d.camelKey] は camelKey が値スキーマの実キーでないと
// コンパイルエラーになり、値スキーマとのドリフトを型で捕捉する。
// 各 snakeKey の zod 型を defs の clear から算出するマップ型。生成物へ精密な型を
// 与え、SDK の ShapeOutput がハンドラ args を各フィールド精密に型付けできるようにする
// (これが無いと index signature が spread で消える or 値が unknown になる)。
type SnakeToCamel = {
	[D in (typeof DRUNK_WINE_FIELD_DEFS)[number] as D["snakeKey"]]: D["camelKey"];
};
type SnakeToClear = {
	[D in (typeof DRUNK_WINE_FIELD_DEFS)[number] as D["snakeKey"]]: D["clear"];
};
type BasePart<S extends DrunkWineSnakeKey> =
	(typeof drunkWineFields)[SnakeToCamel[S] & keyof typeof drunkWineFields];
type NullableOf<T> = T extends { nullable: () => infer R } ? R : never;
type OptionalOf<T> = T extends { optional: () => infer R } ? R : never;
// .describe() は同じ型を返すので型には影響しない。
type UpdatePart<S extends DrunkWineSnakeKey> = SnakeToClear[S] extends "null"
	? NullableOf<BasePart<S>>
	: SnakeToClear[S] extends "never"
		? OptionalOf<BasePart<S>>
		: BasePart<S>;
type RegisterFieldSchemas = { [S in DrunkWineSnakeKey]: BasePart<S> };
type UpdateFieldSchemas = { [S in DrunkWineSnakeKey]: UpdatePart<S> };

// DRUNK_WINE_FIELD_DEFS を走査して raw shape を生成する。ループが全キーを
// 上のマップ型どおりに埋めることを前提に、戻り値を精密型へアサートする。
function buildRegisterFields(): RegisterFieldSchemas {
	const shape = {} as Record<DrunkWineSnakeKey, z.ZodTypeAny>;
	for (const d of DRUNK_WINE_FIELD_DEFS) {
		const base: z.ZodTypeAny = drunkWineFields[d.camelKey];
		shape[d.snakeKey] = base.describe(REGISTER_DESCRIBE[d.snakeKey]);
	}
	return shape as unknown as RegisterFieldSchemas;
}

function buildUpdateFields(): UpdateFieldSchemas {
	const shape = {} as Record<DrunkWineSnakeKey, z.ZodTypeAny>;
	for (const d of DRUNK_WINE_FIELD_DEFS) {
		const base: z.ZodTypeAny = drunkWineFields[d.camelKey];
		// clear 規約から nullable/optional を決める(base は name 以外 optional 済み)
		const withClear =
			d.clear === "null"
				? base.nullable()
				: d.clear === "never"
					? base.optional()
					: base;
		shape[d.snakeKey] = withClear.describe(UPDATE_DESCRIBE[d.snakeKey]);
	}
	return shape as unknown as UpdateFieldSchemas;
}

export const registerDrunkWineInput = {
	...buildRegisterFields(),
	photo_base64: photoBase64,
	photo_mime_type: photoMimeType,
};

// 更新は id のみ必須。未指定(undefined)のフィールドは変更せず、null は
// 「クリアする」の意(Webのserver fnと同じ規約。編集フォームAppが空欄にした
// フィールドを null で送ってくる)。name は必須項目なのでクリア不可。
export const updateDrunkWineInput = {
	id: z
		.string()
		.min(1)
		.max(80)
		.describe(
			"更新するエントリのID (register_drunk_wine / list_drunk_wines の entry.id)",
		),
	...buildUpdateFields(),
	photo_base64: photoBase64,
	photo_mime_type: photoMimeType,
};
