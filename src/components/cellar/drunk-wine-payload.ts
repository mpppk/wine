import {
	collectDrunkWinePatch,
	collectWineTastingPatch,
	type DrunkWineCamelEntry,
	type DrunkWineFormValues,
	type DrunkWinePatch,
	type DrunkWineSnakeKey,
	toCamelCreateFields,
	toCamelPatch,
	toSnakeEntry,
	type WineTastingFormValues,
	type WineTastingPatch,
	type WineTastingSnakeKey,
} from "#/lib/drunk-wine/fields";
import type {
	CreateDrunkWineInput,
	CreateWineTastingInput,
	UpdateDrunkWineInput,
} from "#/lib/drunk-wine/schema";
import {
	DEFAULT_WINE_STATUS,
	WINE_STATUS_IDS,
	type WineStatus,
} from "#/lib/drunk-wine/status";
import type { ReceivedDrunkWineEntry } from "#/lib/mcp-app/entry";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";

// DrunkWineForm の送信ペイロード生成。パッチ規約(空欄→null / 全解除→[] /
// name はクリア不可 / 未変更は送らない)の単一情報源は collectDrunkWinePatch
// (src/lib/drunk-wine/fields.ts)で、ここはフォーム state との形の差
// (rating の number↔文字列、aopId の undefined↔"")を吸収する薄いアダプタに徹する。
//
// コンポーネント本体(DrunkWineForm.tsx)は server fn 経由で cloudflare:workers に
// 到達するため unit テストできない。取り違えを検出できるよう変換だけを純関数として
// 切り出し、drunk-wine-payload.test.ts で固定する。

/**
 * DrunkWineForm の useState 群のうち送信対象のものだけを写した形。
 * regionId は AOP 候補の絞り込みに使う UI 専用 state なので含めない
 * (地域はサーバ側で AOP から導出される)。
 */
export interface DrunkWineFormState {
	name: string;
	status: WineStatus;
	vintage: string;
	producer: string;
	price: string;
	aopId: string | undefined;
	grapeVarietyIds: string[];
}

/**
 * フォーム state を snakeKey keyed の入力値表現へ正規化する。
 * 返り値の satisfies により、DRUNK_WINE_FIELD_DEFS へフィールドを足したのに
 * ここへ足し忘れるとコンパイルエラーになる。
 */
export function toFormValues(s: DrunkWineFormState): DrunkWineFormValues {
	return {
		name: s.name,
		status: s.status,
		vintage: s.vintage,
		price: s.price,
		producer: s.producer,
		// AOP ピッカーは未選択を undefined で持つが、規約側の「空欄」は ""
		aop_id: s.aopId ?? "",
		grape_variety_ids: s.grapeVarietyIds,
	} satisfies Record<DrunkWineSnakeKey, string | string[]>;
}

/**
 * DrunkWineFields が扱う値。送信対象(DrunkWineFormState)に、AOP候補の絞り込み用の
 * regionId を足したもの。Web版フォームと MCP App(/embed/drunk-wine)の両方が
 * この形で state を持つ。
 */
export interface DrunkWineFieldsValue extends DrunkWineFormState {
	regionId: string | undefined;
}

/**
 * 飲用記録1件のフォーム値。銘柄と違い 1:N なので DRUNK_WINE_FIELD_DEFS には
 * 載らない(差分パッチ規約がどの記録への差分かを表せないため)。
 */
export interface WineTastingDraft {
	drankOn: string;
	rating: number | null;
	memo: string;
}

export const EMPTY_TASTING_DRAFT: WineTastingDraft = {
	drankOn: "",
	rating: null,
	memo: "",
};

// 以下の3関数は satisfies で全キーの記入を強制する。toFormValues だけが
// satisfies を持っていた頃は、ここへの足し忘れが静かに落ちていた。
type FieldsValueShape = Record<keyof DrunkWineFieldsValue, unknown>;

/** 送信対象のフィールドだけを取り出す(regionId は AOP から導出されるので送らない)。 */
export function toFormState(value: DrunkWineFieldsValue): DrunkWineFormState {
	return {
		name: value.name,
		status: value.status,
		vintage: value.vintage,
		producer: value.producer,
		price: value.price,
		aopId: value.aopId,
		grapeVarietyIds: value.grapeVarietyIds,
	} satisfies Record<keyof DrunkWineFormState, unknown>;
}

/** Web版フォームの初期値。entry 未指定なら新規作成の空フォーム。 */
export function fieldsValueFromEntry(
	entry?: DrunkWineEntry,
): DrunkWineFieldsValue {
	return {
		name: entry?.name ?? "",
		// 新規作成の既定は「飲み終わった」(従来どおり飲んだ記録を残す導線が主)
		status: entry?.status ?? DEFAULT_WINE_STATUS,
		vintage: entry?.vintage != null ? String(entry.vintage) : "",
		producer: entry?.producer ?? "",
		price: entry?.price != null ? String(entry.price) : "",
		aopId: entry?.aopId ?? undefined,
		regionId: entry?.regionId ?? undefined,
		grapeVarietyIds: entry?.grapeVarietyIds ?? [],
	} satisfies FieldsValueShape;
}

/**
 * MCP App の初期値。ホストから postMessage で届く snake_case のエントリは
 * 外部入力なので、型が違う値は既定値に倒す(1フィールドの不正で全体が壊れない)。
 */
export function fieldsValueFromMcpEntry(
	entry: ReceivedDrunkWineEntry,
): DrunkWineFieldsValue {
	const text = (v: unknown): string => (typeof v === "string" ? v : "");
	const numText = (v: unknown): string =>
		typeof v === "number" && Number.isFinite(v) ? String(v) : "";
	return {
		name: text(entry.name),
		status: isWineStatus(entry.status) ? entry.status : DEFAULT_WINE_STATUS,
		vintage: numText(entry.vintage),
		producer: text(entry.producer),
		price: numText(entry.price),
		aopId: text(entry.aop_id) || undefined,
		regionId: text(entry.region_id) || undefined,
		grapeVarietyIds: Array.isArray(entry.grape_variety_ids)
			? entry.grape_variety_ids.filter((id) => typeof id === "string")
			: [],
	} satisfies FieldsValueShape;
}

function isWineStatus(v: unknown): v is WineStatus {
	return (
		typeof v === "string" && (WINE_STATUS_IDS as readonly string[]).includes(v)
	);
}

/** MCP App の飲用記録セクションの初期値(最新1件の射影)。 */
export function tastingDraftFromMcpEntry(
	entry: ReceivedDrunkWineEntry,
): WineTastingDraft {
	return {
		drankOn: typeof entry.drank_on === "string" ? entry.drank_on : "",
		rating: typeof entry.rating === "number" ? entry.rating : null,
		memo: typeof entry.memo === "string" ? entry.memo : "",
	};
}

function tastingFormValues(draft: WineTastingDraft): WineTastingFormValues {
	return {
		drank_on: draft.drankOn,
		rating: draft.rating == null ? "" : String(draft.rating),
		memo: draft.memo,
	} satisfies Record<WineTastingSnakeKey, string>;
}

/**
 * 作成時に同時に作る飲用記録。全項目が空なら undefined(記録を作らない)。
 * ただし status='finished' のときはサービス層が日付なしで1件作る。
 */
export function buildTastingInput(
	draft: WineTastingDraft,
): CreateWineTastingInput | undefined {
	const drankOn = draft.drankOn.trim();
	const memo = draft.memo.trim();
	if (!drankOn && draft.rating == null && !memo) return undefined;
	return {
		drankOn: drankOn || undefined,
		rating: draft.rating ?? undefined,
		memo: memo || undefined,
	};
}

/**
 * MCP App が送る飲用記録の差分(レガシー引数)。基準は最新1件の射影なので、
 * 銘柄パッチと同じ規約(未変更は送らない / 空欄は null でクリア)で組み立てる。
 */
export function buildMcpTastingArgs(
	entry: ReceivedDrunkWineEntry,
	draft: WineTastingDraft,
): WineTastingPatch {
	return collectWineTastingPatch(
		entry as Record<string, unknown>,
		tastingFormValues(draft),
	);
}

/**
 * MCP境界(snake_case)の差分パッチ。ホスト仲介の tools/call へそのまま
 * arguments として渡す。基準の entry も snake_case なので射影は要らない。
 */
export function buildMcpUpdatePatch(
	entry: ReceivedDrunkWineEntry,
	value: DrunkWineFieldsValue,
): DrunkWinePatch {
	// 差分の基準は、フォームの初期値と同じ正規化を通した形にする。ホストが status を
	// 落として送ってきたとき、素の entry を基準にすると「未編集なのに既定値
	// (finished)を送る」= 手元にあるワインを黙って飲み終わり扱いにしてしまう。
	const base = {
		...(entry as Record<string, unknown>),
		status: isWineStatus(entry.status) ? entry.status : DEFAULT_WINE_STATUS,
	};
	return collectDrunkWinePatch(base, toFormValues(toFormState(value)));
}

/**
 * 新規作成の入力。空欄のフィールドは送らない(= サーバ側で null になる)。
 * 空エントリを基準にした差分は「入力のあったフィールドだけ・null なし」になり、
 * 作成の規約と一致する。
 */
export function buildCreateInput(
	s: DrunkWineFormState,
	tasting?: CreateWineTastingInput,
): CreateDrunkWineInput {
	const patch = collectDrunkWinePatch({}, toFormValues(s));
	// name は clear:"never" なので空文字だと patch に載らない。必須なので明示的に
	// 足し、空欄のまま送られた場合は従来どおりサーバの zod で弾く。
	// status も clear:"never" だが、空エントリ基準なら既定値以外は必ず patch に載る。
	return {
		...toCamelCreateFields(patch),
		name: s.name.trim(),
		status: s.status,
		...(tasting ? { tasting } : {}),
	};
}

/**
 * 既存エントリとの差分パッチ(camelCase、id は含まない)。
 * 変更が無ければ {} を返す(呼び出し側は hasDrunkWinePatch でガードする)。
 */
export function buildUpdatePatch(
	entry: DrunkWineCamelEntry,
	s: DrunkWineFormState,
): Omit<UpdateDrunkWineInput, "id"> {
	return toCamelPatch(
		collectDrunkWinePatch(toSnakeEntry(entry), toFormValues(s)),
	);
}
