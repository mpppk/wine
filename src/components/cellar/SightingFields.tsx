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
import { duplicatePlaceNameMessage } from "#/lib/place/place";
import { PLACE_NAME_MAX, SIGHTING_MEMO_MAX } from "#/lib/place/schema";
import type { PlaceEntry } from "#/lib/services/place-service";

/** 目撃記録1件のフォーム値。数値は入力途中を表せるよう文字列で持つ(飲用記録と同じ流儀)。 */
export interface WineSightingDraft {
	/** 場所の選択。未選択は ""、新規作成は NEW_PLACE_VALUE */
	placeId: string;
	/** その場で作る場所の名前(#495)。`placeId === NEW_PLACE_VALUE` のときだけ意味を持つ。 */
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
const NO_PLACE_VALUE = "__none__";

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
}

/**
 * 目撃記録1件の入力項目(場所 / 見かけた日 / その店での価格 / メモ)。
 *
 * 銘柄の入力(DrunkWineFields)・飲用記録の入力(TastingFields)とは別のコンポーネント
 * にしている。目撃記録は銘柄に対して 1:N で、追加・編集・削除の単位が銘柄と異なる
 * ため(飲用記録と同じ理由。Issue #358)。
 *
 * 場所は**どの経路でもその場で新規作成できる**。かつては新規登録(#495)だけに開き、
 * 編集画面の目撃記録では閉じていた——記録のたびに店を増やせると表記ゆれの店名が
 * 増えるため——が、登録時に場所を入れ損ねると後から作る手段が無くなるため開いた。
 * 表記ゆれの抑制は「同名は作れない」というサーバ側の関門(`prepareNewPlace`)が担う。
 */
export function SightingFields({
	value,
	onChange,
	places,
	idPrefix,
	disabled,
}: SightingFieldsProps) {
	const creatingPlace = value.placeId === NEW_PLACE_VALUE;
	// 同名は作れない(サーバの prepareNewPlace が 409 で弾く)。保存を押すまで
	// 分からないと入力をやり直させることになるので、一覧に同じ名前があれば入力中に出す。
	const newPlaceName = value.newPlaceName.trim();
	const duplicateName =
		creatingPlace && places.some((place) => place.name === newPlaceName);
	return (
		<>
			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<FormField label="場所" htmlFor={`${idPrefix}-place`}>
					<Select
						value={value.placeId || NO_PLACE_VALUE}
						disabled={disabled}
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
							<SelectItem value={NEW_PLACE_VALUE}>新しい場所を追加…</SelectItem>
							{places.map((place) => (
								<SelectItem key={place.id} value={place.id}>
									{place.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{creatingPlace && (
						<>
							<Input
								aria-label="新しい場所の名前"
								value={value.newPlaceName}
								disabled={disabled}
								onChange={(e) => onChange({ newPlaceName: e.target.value })}
								placeholder="例: ビストロ・ド・パリ 渋谷店"
								maxLength={PLACE_NAME_MAX}
								aria-invalid={duplicateName || undefined}
								className="mt-2"
							/>
							{duplicateName && (
								<p className="mt-1 text-sm text-destructive">
									{duplicatePlaceNameMessage(newPlaceName)}
								</p>
							)}
						</>
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
