import type {
	CreateWineEncounterInput,
	UpdateWineEncounterInput,
} from "#/lib/place/schema";
import type { WineEncounterEntry } from "#/lib/services/drunk-wine-service";
import type { LabelJobSighting } from "#/lib/services/label-job-service";

// 体験記録フォームの送信ペイロード生成。コンポーネント本体(EncounterList)は
// server fn 経由で cloudflare:workers に到達するため unit テストできないので、
// 変換だけを純関数として切り出す(drunk-wine-payload.ts と同じ方針)。
//
// パッチ規約は銘柄・飲用記録と揃える: **追加は空欄を送らない / 更新は空欄を null で
// 送ってクリアする**。片方だけ違う規約にすると「消したつもりが消えない」が起きる。
// 旧 sighting-payload.ts の後継で、新規登録・編集の両経路がこの1つを通る。

/** 体験記録1件のフォーム値。数値は入力途中を表せるよう文字列で持つ。 */
export interface WineEncounterDraft {
	/** この回に飲んだか */
	drank: boolean;
	occurredOn: string;
	/** 場所の選択。未選択は ""、新規作成は NEW_PLACE_VALUE */
	placeId: string;
	/** その場で作る場所の名前。`placeId === NEW_PLACE_VALUE` のときだけ意味を持つ。 */
	newPlaceName: string;
	/** 1–5。`drank` が ON のときだけ意味を持つ */
	rating: number | null;
	price: string;
	memo: string;
}

export const EMPTY_ENCOUNTER_DRAFT: WineEncounterDraft = {
	drank: false,
	occurredOn: "",
	placeId: "",
	newPlaceName: "",
	rating: null,
	price: "",
	memo: "",
};

/** 場所を選ばない選択肢の値。空文字は Select が「未選択」と解釈するため使えない。 */
export const NO_PLACE_VALUE = "__none__";

/** その場で場所を作る選択肢の値。実IDと衝突しない形にする。 */
export const NEW_PLACE_VALUE = "__new__";

/** 既存の体験記録をフォーム値へ写す。 */
export function draftFromEncounter(
	entry: WineEncounterEntry,
): WineEncounterDraft {
	return {
		drank: entry.drank,
		occurredOn: entry.occurredOn ?? "",
		placeId: entry.placeId ?? "",
		// 既存の記録は場所が確定しているので、新規作成の入力は常に空
		newPlaceName: "",
		rating: entry.rating,
		price: entry.price != null ? String(entry.price) : "",
		memo: entry.memo ?? "",
	};
}

/**
 * 解析ジョブに残っていた「どこで・いつ撮ったか」をフォーム値へ写す。
 *
 * 新規作成の場所は place 行がまだ無いので、名前を持ったまま「新しい場所を追加…」の
 * 選択状態にする(投入時と同じ見え方で復元する)。
 */
export function draftFromLabelJobEncounter(
	sighting: LabelJobSighting,
): WineEncounterDraft {
	return {
		...EMPTY_ENCOUNTER_DRAFT,
		...(sighting.newPlaceName
			? { placeId: NEW_PLACE_VALUE, newPlaceName: sighting.newPlaceName }
			: sighting.placeId
				? { placeId: sighting.placeId }
				: {}),
		...(sighting.seenOn ? { occurredOn: sighting.seenOn } : {}),
	};
}

/** 数値入力(文字列)を整数に寄せる。空・数値化できない値は undefined。 */
function toIntOrUndefined(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * 場所の選択をペイロードの形に写す。「新しい場所を追加…」は `newPlace` になる。
 *
 * 名前が空なら「場所の指定なし」に倒す。選択だけして名前を書かずに保存した回を
 * 弾くより、出会った事実を残すほうが記録の敷居が低い。**更新時は `null`(クリア)、
 * 追加時は未指定**と意味が分かれるので、「場所なし」のときに載せるキーは
 * 呼び出し側から受け取る。
 */
function placePayload<T extends object>(draft: WineEncounterDraft, noPlace: T) {
	if (draft.placeId === NEW_PLACE_VALUE) {
		const name = draft.newPlaceName.trim();
		return name ? { newPlace: { name } } : noPlace;
	}
	return draft.placeId ? { placeId: draft.placeId } : noPlace;
}

/**
 * 追加時の入力。空欄のフィールドは送らない(= サーバ側で null になる)。
 * `drank` は必須なので常送る。
 *
 * 場所はその場で新規作成できる(編集画面の記録からも作れる。同名の場所が既に
 * あればサーバ(`prepareNewPlace`)が 409 で弾く)。
 */
export function buildAddEncounterInput(
	draft: WineEncounterDraft,
): CreateWineEncounterInput {
	const memo = draft.memo.trim();
	return {
		drank: draft.drank,
		...placePayload(draft, {}),
		...(draft.occurredOn ? { occurredOn: draft.occurredOn } : {}),
		// 評価は飲んだ回だけの属性。OFF の回に残っていても送らない
		...(draft.drank && draft.rating != null ? { rating: draft.rating } : {}),
		...(toIntOrUndefined(draft.price) != null
			? { price: toIntOrUndefined(draft.price) }
			: {}),
		...(memo ? { memo } : {}),
	};
}

/**
 * 銘柄の新規作成に添える体験記録。**「記録する内容が何も無ければ」undefined**
 * (記録を作らない)——旧 `buildCreateEntrySightingInput` と同じ規約で、写真から
 * 登録した回に場所も日付も入れていなければ体験記録は生まれない。
 *
 * ただし「飲んだ」トグルが ON なら、全項目が空でも記録を作る(日付・評価を
 * 覚えていなくても「飲んだ」という事実は残す。markWineDrunk・一括登録と同じ扱い)。
 *
 * 新規作成の場所は名前が空なら「場所の指定なし」に倒す。選択だけして名前を書かずに
 * 保存した回で登録ごと弾くより、出会った事実を残すほうが記録の敷居が低い
 * (place は名前必須なので、空のまま送ればサーバの zod で落ちる)。
 */
export function buildCreateEntryEncounterInput(
	draft: WineEncounterDraft,
): CreateWineEncounterInput | undefined {
	// 「場所の指定」は正規化後の意味で見る。選択が「新規作成」で名前が空の回や、
	// 選択が空のまま名前だけ残っている回は、送信時に場所なしへ倒すため
	// 内容として数えない(旧 buildCreateEntrySightingInput と同じ規約)。
	// 価格も同様に、数値にならない入力は送られないので内容として数えない。
	const hasPlace =
		draft.placeId === NEW_PLACE_VALUE
			? draft.newPlaceName.trim() !== ""
			: draft.placeId !== "";
	if (
		!draft.drank &&
		!draft.occurredOn &&
		!hasPlace &&
		draft.rating == null &&
		toIntOrUndefined(draft.price) == null &&
		!draft.memo.trim()
	) {
		return undefined;
	}
	return buildAddEncounterInput(draft);
}

/**
 * 更新時の入力。空欄は null(クリア)として送る。`drank` は常送りで、OFF に
 * 倒した回の `rating` は null でクリアする(意味を持たない評価を不可視のまま
 * 残さない)。
 *
 * batchId / photoIndex / photoIndexes は**送らない**。由来(どの一括登録のどの写真か)はユーザが
 * 編集する情報ではなく、未指定なら drizzle が列を触らないので値が保たれる。
 *
 * 場所を新規作成するときは `placeId` を送らず `newPlace` だけを送る(サーバが採番した
 * 新しい id が入る)。両方送るとサーバの zod が排他違反で弾く。
 */
export function buildUpdateEncounterInput(
	id: string,
	draft: WineEncounterDraft,
): UpdateWineEncounterInput {
	const memo = draft.memo.trim();
	return {
		id,
		drank: draft.drank,
		...placePayload(draft, { placeId: null }),
		occurredOn: draft.occurredOn || null,
		rating: draft.drank ? draft.rating : null,
		price: toIntOrUndefined(draft.price) ?? null,
		memo: memo || null,
	};
}

/** 体験記録の下書きが同値か(離脱ガードの判定)。 */
export function encounterDraftEquals(
	a: WineEncounterDraft,
	b: WineEncounterDraft,
): boolean {
	return (
		a.drank === b.drank &&
		a.occurredOn === b.occurredOn &&
		a.placeId === b.placeId &&
		a.newPlaceName.trim() === b.newPlaceName.trim() &&
		a.rating === b.rating &&
		a.price.trim() === b.price.trim() &&
		a.memo.trim() === b.memo.trim()
	);
}
