import { FormField } from "#/components/ui/form-section";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { PRICE_MAX, PRICE_MIN } from "#/lib/drunk-wine/schema";
import { PLACE_NAME_MAX, SIGHTING_MEMO_MAX } from "#/lib/place/schema";
import type { PlaceEntry } from "#/lib/services/place-service";

/** 目撃記録1件のフォーム値。数値は入力途中を表せるよう文字列で持つ(飲用記録と同じ流儀)。 */
export interface WineSightingDraft {
	/** 場所の選択。未選択は ""、新規作成は NEW_PLACE_VALUE */
	placeId: string;
	/**
	 * その場で作る場所の名前(#495)。`placeId === NEW_PLACE_VALUE` のときだけ意味を持つ。
	 * 新規作成を許さない呼び出し側(既存エントリへの目撃記録の追加)では常に空。
	 */
	newPlaceName: string;
	seenOn: string;
	price: string;
	memo: string;
}

export const EMPTY_SIGHTING_DRAFT: WineSightingDraft = {
	placeId: "",
	newPlaceName: "",
	seenOn: "",
	price: "",
	memo: "",
};

/** 場所を選ばない選択肢の値。空文字は Select が「未選択」と解釈するため使えない。 */
export const NO_PLACE_VALUE = "__none__";

/** その場で場所を作る選択肢の値(#495)。実IDと衝突しない形にする。 */
export const NEW_PLACE_VALUE = "__new__";

export interface SightingFieldsProps {
	value: WineSightingDraft;
	/** 変更のあったキーだけを渡す。呼び出し側が state にマージする。 */
	onChange: (patch: Partial<WineSightingDraft>) => void;
	/** 選択できる場所(ユーザ単位のマスタ)。 */
	places: PlaceEntry[];
	/** DOM id の接頭辞。同一ページに複数の目撃記録フォームが並ぶため必須 */
	idPrefix: string;
	disabled?: boolean;
	/**
	 * 「新しい場所を追加…」を選べるようにするか(#495)。既定は false。
	 *
	 * 既存エントリへの目撃記録の追加(SightingList)では false のまま——記録のたびに
	 * 場所を作れると表記ゆれの店名が増える。true にするのは**写真から登録した回**だけで、
	 * そちらは一括登録と同じ「その機会に見かけた店をその場で登録する」文脈にあり、
	 * ここで作れないと単体登録の利用者は場所を1つも作れない。
	 */
	allowNewPlace?: boolean;
}

/**
 * 目撃記録1件の入力項目(場所 / 見かけた日 / その店での価格 / メモ)。
 *
 * 銘柄の入力(DrunkWineFields)・飲用記録の入力(TastingFields)とは別のコンポーネント
 * にしている。目撃記録は銘柄に対して 1:N で、追加・編集・削除の単位が銘柄と異なる
 * ため(飲用記録と同じ理由。Issue #358)。
 *
 * 場所の**新規作成は既定では持たない**。記録のたびに店を増やせるようにすると、表記ゆれの
 * 店名が目撃記録ごとに増えていく。写真から登録する経路だけが `allowNewPlace` で新規作成を
 * 開く(#495)——そちらは「その機会に見かけた店をその場で登録する」文脈で、閉じたままだと
 * 単体登録しか通らない利用者は場所を1つも作れない。
 */
export function SightingFields({
	value,
	onChange,
	places,
	idPrefix,
	disabled,
	allowNewPlace,
}: SightingFieldsProps) {
	const creatingPlace = allowNewPlace && value.placeId === NEW_PLACE_VALUE;
	return (
		<>
			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<FormField
					label="場所"
					htmlFor={`${idPrefix}-place`}
					description={
						places.length === 0 && !allowNewPlace
							? "場所は「写真からまとめて登録」で作成できます"
							: undefined
					}
				>
					<Select
						value={value.placeId || NO_PLACE_VALUE}
						disabled={disabled || (places.length === 0 && !allowNewPlace)}
						onValueChange={(v) =>
							onChange({
								placeId: v === NO_PLACE_VALUE ? "" : v,
								// 別の選択へ移ったら入力中の店名は残さない(送信対象から外れる値が
								// 画面から見えないまま残ると、選び直しで意図せず復活する)
								...(v === NEW_PLACE_VALUE ? {} : { newPlaceName: "" }),
							})
						}
					>
						<SelectTrigger id={`${idPrefix}-place`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NO_PLACE_VALUE}>指定しない</SelectItem>
							{allowNewPlace && (
								<SelectItem value={NEW_PLACE_VALUE}>
									新しい場所を追加…
								</SelectItem>
							)}
							{places.map((place) => (
								<SelectItem key={place.id} value={place.id}>
									{place.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{creatingPlace && (
						<Input
							aria-label="新しい場所の名前"
							value={value.newPlaceName}
							disabled={disabled}
							onChange={(e) => onChange({ newPlaceName: e.target.value })}
							placeholder="例: ビストロ・ド・パリ 渋谷店"
							maxLength={PLACE_NAME_MAX}
							className="mt-2"
						/>
					)}
				</FormField>

				<FormField label="見かけた日" htmlFor={`${idPrefix}-seen-on`}>
					<Input
						id={`${idPrefix}-seen-on`}
						type="date"
						value={value.seenOn}
						disabled={disabled}
						onChange={(e) => onChange({ seenOn: e.target.value })}
					/>
				</FormField>
			</div>

			<FormField label="その店での価格(円)" htmlFor={`${idPrefix}-price`}>
				<Input
					id={`${idPrefix}-price`}
					type="number"
					inputMode="numeric"
					min={PRICE_MIN}
					max={PRICE_MAX}
					value={value.price}
					disabled={disabled}
					onChange={(e) => onChange({ price: e.target.value })}
					placeholder="例: 12000"
				/>
			</FormField>

			<FormField label="メモ" htmlFor={`${idPrefix}-memo`}>
				<Textarea
					id={`${idPrefix}-memo`}
					value={value.memo}
					disabled={disabled}
					onChange={(e) => onChange({ memo: e.target.value })}
					maxLength={SIGHTING_MEMO_MAX}
					rows={2}
					placeholder="例: グラスでも提供していた"
				/>
			</FormField>
		</>
	);
}
