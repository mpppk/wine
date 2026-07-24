import {
	collectDrunkWinePatch,
	type DrunkWineCamelEntry,
	type DrunkWineFormValues,
	type DrunkWinePatch,
	type DrunkWineSnakeKey,
	toCamelCreateFields,
	toCamelPatch,
	toSnakeEntry,
} from "#/lib/drunk-wine/fields";
import type {
	CreateDrunkWineInput,
	UpdateDrunkWineInput,
} from "#/lib/drunk-wine/schema";
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
	drankOn: string;
	rating: number | null;
	vintage: string;
	producer: string;
	price: string;
	aopId: string | undefined;
	grapeVarietyIds: string[];
	memo: string;
}

/**
 * フォーム state を snakeKey keyed の入力値表現へ正規化する。
 * 返り値の satisfies により、DRUNK_WINE_FIELD_DEFS へフィールドを足したのに
 * ここへ足し忘れるとコンパイルエラーになる。
 */
export function toFormValues(s: DrunkWineFormState): DrunkWineFormValues {
	return {
		name: s.name,
		drank_on: s.drankOn,
		// 星ボタンは number|null で持つが、規約側は input.value 相当の文字列で扱う
		rating: s.rating == null ? "" : String(s.rating),
		vintage: s.vintage,
		price: s.price,
		producer: s.producer,
		// AOP ピッカーは未選択を undefined で持つが、規約側の「空欄」は ""
		aop_id: s.aopId ?? "",
		grape_variety_ids: s.grapeVarietyIds,
		memo: s.memo,
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

/** 送信対象のフィールドだけを取り出す(regionId は AOP から導出されるので送らない)。 */
export function toFormState(value: DrunkWineFieldsValue): DrunkWineFormState {
	return {
		name: value.name,
		drankOn: value.drankOn,
		rating: value.rating,
		vintage: value.vintage,
		producer: value.producer,
		price: value.price,
		aopId: value.aopId,
		grapeVarietyIds: value.grapeVarietyIds,
		memo: value.memo,
	};
}

/** Web版フォームの初期値。entry 未指定なら新規作成の空フォーム。 */
export function fieldsValueFromEntry(
	entry?: DrunkWineEntry,
): DrunkWineFieldsValue {
	return {
		name: entry?.name ?? "",
		drankOn: entry?.drankOn ?? "",
		rating: entry?.rating ?? null,
		vintage: entry?.vintage != null ? String(entry.vintage) : "",
		producer: entry?.producer ?? "",
		price: entry?.price != null ? String(entry.price) : "",
		aopId: entry?.aopId ?? undefined,
		regionId: entry?.regionId ?? undefined,
		grapeVarietyIds: entry?.grapeVarietyIds ?? [],
		memo: entry?.memo ?? "",
	};
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
		drankOn: text(entry.drank_on),
		rating: typeof entry.rating === "number" ? entry.rating : null,
		vintage: numText(entry.vintage),
		producer: text(entry.producer),
		price: numText(entry.price),
		aopId: text(entry.aop_id) || undefined,
		regionId: text(entry.region_id) || undefined,
		grapeVarietyIds: Array.isArray(entry.grape_variety_ids)
			? entry.grape_variety_ids.filter((id) => typeof id === "string")
			: [],
		memo: text(entry.memo),
	};
}

/**
 * MCP境界(snake_case)の差分パッチ。ホスト仲介の tools/call へそのまま
 * arguments として渡す。基準の entry も snake_case なので射影は要らない。
 */
export function buildMcpUpdatePatch(
	entry: ReceivedDrunkWineEntry,
	value: DrunkWineFieldsValue,
): DrunkWinePatch {
	return collectDrunkWinePatch(
		entry as Record<string, unknown>,
		toFormValues(toFormState(value)),
	);
}

/**
 * 新規作成の入力。空欄のフィールドは送らない(= サーバ側で null になる)。
 * 空エントリを基準にした差分は「入力のあったフィールドだけ・null なし」になり、
 * 作成の規約と一致する。
 */
export function buildCreateInput(s: DrunkWineFormState): CreateDrunkWineInput {
	const patch = collectDrunkWinePatch({}, toFormValues(s));
	// name は clear:"never" なので空文字だと patch に載らない。必須なので明示的に
	// 足し、空欄のまま送られた場合は従来どおりサーバの zod で弾く。
	return { ...toCamelCreateFields(patch), name: s.name.trim() };
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
