import { z } from "zod";
import { AI_MAX_QUESTION_CHARS, REGION_QA_MODEL_KEYS } from "#/lib/ai/config";
import {
	DRUNK_WINE_FIELD_DEFS,
	type DrunkWineSnakeKey,
	WINE_TASTING_FIELDS,
	type WineTastingSnakeKey,
} from "#/lib/drunk-wine/fields";
import { CELLAR_FILTER_IDS } from "#/lib/drunk-wine/filter";
import {
	DRUNK_WINE_MAX_PAGE_SIZE,
	DRUNK_WINE_PAGE_SIZE,
} from "#/lib/drunk-wine/pagination";
import { drunkWineFields, wineTastingFields } from "#/lib/drunk-wine/schema";
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

const STATUS_DESCRIBE =
	"所有状態。wishlist=気になる(未購入) / owned=手元にある / finished=飲み終えた。" +
	"省略時は finished(飲み終えた記録として登録される)";

const REGISTER_DESCRIBE: Record<DrunkWineSnakeKey, string> = {
	name: "ワイン名(ラベル表記。必須)",
	status: STATUS_DESCRIBE,
	vintage: "ヴィンテージ (1800〜2100の年)",
	price: "価格 (円)",
	producer: "生産者名 (200文字まで)",
	aop_id: "紐付けるAOPのID (list_aopsのid。任意)",
	grape_variety_ids: "ぶどう品種ID (list_grape_varietiesのid。最大20件)",
};

// null クリア可のフィールドは「。nullでクリア」、品種は「。[]でクリア」を付す。
// name / status はクリア不可なので付けない。
const UPDATE_DESCRIBE: Record<DrunkWineSnakeKey, string> = {
	name: "ワイン名(ラベル表記)",
	status:
		"所有状態。wishlist=気になる(未購入) / owned=手元にある / finished=飲み終えた",
	vintage: "ヴィンテージ (1800〜2100の年)。nullでクリア",
	price: "価格 (円)。nullでクリア",
	producer: "生産者名 (200文字まで)。nullでクリア",
	aop_id: "紐付けるAOPのID (list_aopsのid)。nullでクリア",
	grape_variety_ids:
		"ぶどう品種ID (list_grape_varietiesのid。最大20件)。[]でクリア",
};

// 飲用記録(wine_tasting)の引数。DRUNK_WINE_FIELD_DEFS 由来ではないので
// photo_base64 と同じく手書きで足す。ツール名も既存引数名も変えないことで、
// 既存の外部クライアント(Claude 等)は従来どおりの呼び方が通り続ける。
const REGISTER_TASTING_DESCRIBE: Record<WineTastingSnakeKey, string> = {
	drank_on: "飲んだ日 (YYYY-MM-DD)。指定すると飲用記録1件付きで登録する",
	rating: "評価 (1〜5の整数)。飲用記録に記録される",
	memo: "メモ・感想 (2000文字まで)。飲用記録に記録される",
};

const UPDATE_TASTING_DESCRIBE: Record<WineTastingSnakeKey, string> = {
	drank_on:
		"最新の飲用記録の飲んだ日を更新する (YYYY-MM-DD)。飲用記録が無ければ1件作成。" +
		"nullで日付だけクリア(記録自体は消えない)。別の日に飲んだ記録を足すには add_wine_tasting を使う",
	rating: "最新の飲用記録の評価 (1〜5の整数)。nullでクリア",
	memo: "最新の飲用記録のメモ (2000文字まで)。nullでクリア",
};

type TastingFieldSchemas = {
	[S in WineTastingSnakeKey]: (typeof wineTastingFields)[Extract<
		(typeof WINE_TASTING_FIELDS)[number],
		{ snakeKey: S }
	>["camelKey"]];
};
type NullableTastingFieldSchemas = {
	[S in WineTastingSnakeKey]: NullableOf<TastingFieldSchemas[S]>;
};

function buildTastingFields(
	describe: Record<WineTastingSnakeKey, string>,
): TastingFieldSchemas {
	const shape = {} as Record<WineTastingSnakeKey, z.ZodTypeAny>;
	for (const d of WINE_TASTING_FIELDS) {
		shape[d.snakeKey] = wineTastingFields[d.camelKey].describe(
			describe[d.snakeKey],
		);
	}
	return shape as unknown as TastingFieldSchemas;
}

/** 更新側は「nullでその列をクリア」を許す(記録の行自体は消さない)。 */
function buildNullableTastingFields(
	describe: Record<WineTastingSnakeKey, string>,
): NullableTastingFieldSchemas {
	const shape = {} as Record<WineTastingSnakeKey, z.ZodTypeAny>;
	for (const d of WINE_TASTING_FIELDS) {
		shape[d.snakeKey] = wineTastingFields[d.camelKey]
			.nullable()
			.describe(describe[d.snakeKey]);
	}
	return shape as unknown as NullableTastingFieldSchemas;
}

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

const entryIdArg = z
	.string()
	.min(1)
	.max(80)
	.describe(
		"更新するエントリのID (register_drunk_wine / list_drunk_wines の entry.id)",
	);

export const registerDrunkWineInput = {
	...buildRegisterFields(),
	...buildTastingFields(REGISTER_TASTING_DESCRIBE),
	photo_base64: photoBase64,
	photo_mime_type: photoMimeType,
};

// 更新は id のみ必須。未指定(undefined)のフィールドは変更せず、null は
// 「クリアする」の意(Webのserver fnと同じ規約。編集フォームAppが空欄にした
// フィールドを null で送ってくる)。name / status は必須項目なのでクリア不可。
export const updateDrunkWineInput = {
	id: entryIdArg,
	...buildUpdateFields(),
	...buildNullableTastingFields(UPDATE_TASTING_DESCRIBE),
	photo_base64: photoBase64,
	photo_mime_type: photoMimeType,
};

// 飲用記録を1件足す。update_drunk_wine の飲用記録引数は「最新1件の更新」なので、
// 同じワインを別の日に飲んだ記録を残すにはこちらを使う。
export const addWineTastingInput = {
	drunk_wine_id: entryIdArg.describe(
		"飲用記録を足すエントリのID (list_drunk_wines の entry.id)",
	),
	...buildTastingFields({
		drank_on: "飲んだ日 (YYYY-MM-DD)。省略可(日付を覚えていない場合)",
		rating: "評価 (1〜5の整数)",
		memo: "メモ・感想 (2000文字まで)",
	}),
};

// マイセラー一覧。件数が増えるとツール結果がそのまま LLM のコンテキスト入力になるため、
// 既定でページングする(#254)。続きは前回応答の next_cursor を渡して取る。
export const listDrunkWinesInput = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(DRUNK_WINE_MAX_PAGE_SIZE)
		.optional()
		.describe(
			`1回で返す件数 (1〜${DRUNK_WINE_MAX_PAGE_SIZE}。既定 ${DRUNK_WINE_PAGE_SIZE})`,
		),
	cursor: z
		.string()
		.max(200)
		.optional()
		.describe("続きを取得するカーソル (前回応答の next_cursor をそのまま渡す)"),
	filter: z
		.enum(CELLAR_FILTER_IDS)
		.optional()
		.describe(
			"絞り込み: all=すべて(既定) / tasted=飲んだことがある / owned=セラーにある / wishlist=気になる",
		),
};
