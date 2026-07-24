import {
	collectDrunkWinePatch,
	type DrunkWineCamelEntry,
	type DrunkWineFormValues,
	type DrunkWineSnakeKey,
	toCamelCreateFields,
	toCamelPatch,
	toSnakeEntry,
} from "#/lib/drunk-wine/fields";
import type {
	CreateDrunkWineInput,
	UpdateDrunkWineInput,
} from "#/lib/drunk-wine/schema";

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
