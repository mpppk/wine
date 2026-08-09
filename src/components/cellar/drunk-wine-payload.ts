import {
	EMPTY_SIGHTING_DRAFT,
	type WineSightingDraft,
} from "#/components/cellar/SightingFields";
import {
	collectDrunkWinePatch,
	collectWineTastingPatch,
	type DrunkWineCamelEntry,
	type DrunkWineFormValues,
	type DrunkWinePatch,
	type DrunkWineSnakeKey,
	stripDerivedProvenance,
	toCamelCreateFields,
	toCamelPatch,
	toSnakeEntry,
	type WineTastingFormValues,
	type WineTastingPatch,
	type WineTastingSnakeKey,
} from "#/lib/drunk-wine/fields";
import type {
	CreateWineTastingInput,
	UpdateDrunkWineInput,
} from "#/lib/drunk-wine/schema";
import {
	DEFAULT_WINE_STATUS,
	WINE_STATUS_IDS,
	type WineStatus,
} from "#/lib/drunk-wine/status";
import type { ReceivedDrunkWineEntry } from "#/lib/mcp-app/entry";
import type {
	CreateDrunkWineWithSightingInput,
	CreateEntrySightingInput,
} from "#/lib/place/schema";
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
 * 産地紐付け(aopId / regionId / countryId)は「最も細かい1つだけ」を保持する
 * (産地ピッカーが選択時に他の2つを undefined にする)。
 */
export interface DrunkWineFormState {
	name: string;
	status: WineStatus;
	vintage: string;
	producer: string;
	price: string;
	aopId: string | undefined;
	regionId: string | undefined;
	countryId: string | undefined;
	grapeVarietyIds: string[];
	/** 銘柄についてのコメント(香り・味わい・生産者)。解析が埋め、利用者が編集できる */
	note: string;
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
		// 産地ピッカーは未選択を undefined で持つが、規約側の「空欄」は ""
		aop_id: s.aopId ?? "",
		region_id: s.regionId ?? "",
		country_id: s.countryId ?? "",
		grape_variety_ids: s.grapeVarietyIds,
		note: s.note,
	} satisfies Record<DrunkWineSnakeKey, string | string[]>;
}

/**
 * DrunkWineFields が扱う値。Web版フォームと MCP App(/embed/drunk-wine)の両方が
 * この形で state を持つ。以前は AOP候補絞り込み用の regionId(UI専用)を上乗せして
 * いたが、regionId 自体が保存対象(地域単位の紐付け)になったため送信対象と同形。
 */
export type DrunkWineFieldsValue = DrunkWineFormState;

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

/** 送信対象のフィールドだけを取り出す(現在は DrunkWineFieldsValue と同形の写し)。 */
export function toFormState(value: DrunkWineFieldsValue): DrunkWineFormState {
	return {
		name: value.name,
		status: value.status,
		vintage: value.vintage,
		producer: value.producer,
		price: value.price,
		aopId: value.aopId,
		regionId: value.regionId,
		countryId: value.countryId,
		grapeVarietyIds: value.grapeVarietyIds,
		note: value.note,
	} satisfies Record<keyof DrunkWineFormState, unknown>;
}

/**
 * サーバのエントリ表現(地域・国は細→粗へ導出済み)から、フォームが持つ
 * 「最も細かい1つだけ」の産地紐付けへ写す。AOP紐付きのエントリは regionId /
 * countryId が導出値で非nullだが、それをフォームに持たせると「地域も選択済み」に
 * 見えてしまうため、ここで落とす。
 */
function provenanceFromDerived(link: {
	aopId: string | undefined;
	regionId: string | undefined;
	countryId: string | undefined;
}): Pick<DrunkWineFormState, "aopId" | "regionId" | "countryId"> {
	if (link.aopId) {
		return { aopId: link.aopId, regionId: undefined, countryId: undefined };
	}
	if (link.regionId) {
		return { aopId: undefined, regionId: link.regionId, countryId: undefined };
	}
	return { aopId: undefined, regionId: undefined, countryId: link.countryId };
}

/** Web版フォームの初期値。entry 未指定なら新規作成の空フォーム。 */
export function fieldsValueFromEntry(
	entry?: DrunkWineEntry,
): DrunkWineFieldsValue {
	return {
		name: entry?.name ?? "",
		// 新規作成の既定は「飲んだ」(従来どおり飲んだ記録を残す導線が主)
		status: entry?.status ?? DEFAULT_WINE_STATUS,
		vintage: entry?.vintage != null ? String(entry.vintage) : "",
		producer: entry?.producer ?? "",
		price: entry?.price != null ? String(entry.price) : "",
		...provenanceFromDerived({
			aopId: entry?.aopId ?? undefined,
			regionId: entry?.regionId ?? undefined,
			countryId: entry?.countryId ?? undefined,
		}),
		grapeVarietyIds: entry?.grapeVarietyIds ?? [],
		note: entry?.note ?? "",
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
		...provenanceFromDerived({
			aopId: text(entry.aop_id) || undefined,
			regionId: text(entry.region_id) || undefined,
			countryId: text(entry.country_id) || undefined,
		}),
		grapeVarietyIds: Array.isArray(entry.grape_variety_ids)
			? entry.grape_variety_ids.filter((id) => typeof id === "string")
			: [],
		note: text(entry.note),
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
	// 産地の粗い2列は導出値が入っているため、基準からは落とす(排他の不変条件に
	// 合わせないと「未変更なのに region_id: null を送る」差分が毎回できる)。
	const base = stripDerivedProvenance({
		...(entry as Record<string, unknown>),
		status: isWineStatus(entry.status) ? entry.status : DEFAULT_WINE_STATUS,
	});
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
	/** 同時に作る目撃記録(#495)。入力が無ければ未指定 */
	sighting?: CreateEntrySightingInput,
): CreateDrunkWineWithSightingInput {
	const patch = collectDrunkWinePatch({}, toFormValues(s));
	// name は clear:"never" なので空文字だと patch に載らない。必須なので明示的に
	// 足し、空欄のまま送られた場合は従来どおりサーバの zod で弾く。
	// status も clear:"never" だが、空エントリ基準なら既定値以外は必ず patch に載る。
	return {
		...toCamelCreateFields(patch),
		name: s.name.trim(),
		status: s.status,
		...(tasting ? { tasting } : {}),
		...(sighting ? { sighting } : {}),
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
	// 基準の粗い産地2列は導出値なので落とす(buildMcpUpdatePatch と同じ理由)
	return toCamelPatch(
		collectDrunkWinePatch(
			stripDerivedProvenance(toSnakeEntry(entry)),
			toFormValues(s),
		),
	);
}

// ---- 未保存の変更(離脱ガード) ---------------------------------------------
// フォームの state は全てローカルなので、離脱すると内容が消える。特に「エチケットから
// 自動入力」は AI クレジットを消費して値を埋めるため、失われるのは入力の手間だけでは
// ない(#238)。判定はここに置き、フォーム側でフィールドを再列挙しない。

/**
 * 比較用に正規化した送信対象フィールド。
 * satisfies により、DrunkWineFormState へフィールドを足したのにここへ足し忘れると
 * コンパイルエラーになる(比較漏れ=「変更したのに警告が出ない」を防ぐ)。
 */
function normalizeFormState(s: DrunkWineFormState) {
	return {
		name: s.name.trim(),
		status: s.status,
		vintage: s.vintage.trim(),
		producer: s.producer.trim(),
		price: s.price.trim(),
		// 産地未選択は undefined と "" のどちらもありうる
		aopId: s.aopId ?? "",
		regionId: s.regionId ?? "",
		countryId: s.countryId ?? "",
		// 並び順は送信内容に影響しないので集合として比較する
		grapeVarietyIds: [...s.grapeVarietyIds].sort().join(","),
		note: s.note.trim(),
	} satisfies Record<keyof DrunkWineFormState, string>;
}

/** 送信対象のフィールドが同値か(前後空白と品種の並び順は無視する)。 */
export function drunkWineFormStateEquals(
	a: DrunkWineFormState,
	b: DrunkWineFormState,
): boolean {
	const na = normalizeFormState(a);
	const nb = normalizeFormState(b);
	return (Object.keys(na) as (keyof typeof na)[]).every((k) => na[k] === nb[k]);
}

/** 飲用記録の下書きが同値か。 */
function tastingDraftEquals(a: WineTastingDraft, b: WineTastingDraft): boolean {
	return (
		a.drankOn === b.drankOn &&
		a.rating === b.rating &&
		a.memo.trim() === b.memo.trim()
	);
}

/** 目撃記録の下書きが同値か(#495)。 */
function sightingDraftEquals(
	a: WineSightingDraft,
	b: WineSightingDraft,
): boolean {
	return (
		a.placeId === b.placeId &&
		a.newPlaceName.trim() === b.newPlaceName.trim() &&
		a.seenOn === b.seenOn &&
		a.price.trim() === b.price.trim() &&
		a.memo.trim() === b.memo.trim()
	);
}

export interface UnsavedDrunkWineChangesInput {
	/** 初期表示の値(= 直近に保存済みの内容)。fieldsValueFromEntry の結果を渡す。 */
	initial: DrunkWineFieldsValue;
	/** 現在のフォーム値。 */
	values: DrunkWineFieldsValue;
	/** 新規作成時の「最初の1件」の飲用記録。編集時は EMPTY_TASTING_DRAFT のまま。 */
	tasting: WineTastingDraft;
	/**
	 * 新規作成時の「見かけた記録」(#495)。編集時・入力欄を出していない画面では
	 * EMPTY_SIGHTING_DRAFT のまま。
	 *
	 * **写真ウィザードから引き継いだ場所・見かけた日も未保存の変更として扱う**
	 * (引き継いだ値は空の下書きと一致しないため)。解析で得た内容と同じく、
	 * 黙って捨てさせない。
	 */
	sighting: WineSightingDraft;
	/** 保存済みの写真キー(表示順)。 */
	initialPhotoKeys: readonly string[];
	/** 現在の写真(表示順)。既存はR2キー、まだ保存していない新規写真は null。 */
	photoKeys: readonly (string | null)[];
}

/** 保存されていない変更があるか(離脱ガードの判定)。 */
export function hasUnsavedDrunkWineChanges({
	initial,
	values,
	tasting,
	sighting,
	initialPhotoKeys,
	photoKeys,
}: UnsavedDrunkWineChangesInput): boolean {
	if (!drunkWineFormStateEquals(toFormState(values), toFormState(initial))) {
		return true;
	}
	if (!tastingDraftEquals(tasting, EMPTY_TASTING_DRAFT)) return true;
	if (!sightingDraftEquals(sighting, EMPTY_SIGHTING_DRAFT)) return true;
	// 追加・削除・並べ替えのいずれも「保存すると結果が変わる」ので未保存扱いにする。
	if (photoKeys.length !== initialPhotoKeys.length) return true;
	return photoKeys.some((key, i) => key !== initialPhotoKeys[i]);
}
