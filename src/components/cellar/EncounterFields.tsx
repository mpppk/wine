import {
	NEW_PLACE_VALUE,
	NO_PLACE_VALUE,
	type WineEncounterDraft,
} from "#/components/cellar/encounter-payload";
import { RatingStarsInput } from "#/components/cellar/RatingStarsInput";
import { FormField } from "#/components/ui/form-section";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { Textarea } from "#/components/ui/textarea";
import { PRICE_MAX, PRICE_MIN } from "#/lib/drunk-wine/schema";
import { duplicatePlaceNameMessage } from "#/lib/place/place";
import { PLACE_NAME_MAX } from "#/lib/place/schema";
import type { PlaceEntry } from "#/lib/services/place-service";

export interface EncounterFieldsProps {
	value: WineEncounterDraft;
	/** 変更のあったキーだけを渡す。呼び出し側が state にマージする。 */
	onChange: (patch: Partial<WineEncounterDraft>) => void;
	/** 選択できる場所(ユーザ単位のマスタ)。 */
	places: PlaceEntry[];
	/** DOM id の接頭辞。同一ページに複数の体験記録フォームが並ぶため必須 */
	idPrefix: string;
	disabled?: boolean;
}

/**
 * 体験記録1件の入力項目(飲んだトグル / 日付 / 場所 / 評価 / 価格 / メモ)。
 *
 * 旧 TastingFields(飲用記録)+ SightingFields(目撃記録)を1本に統合したもの
 * (Issue #606)。「そのワインに出会った1回」が1行で、飲んだかどうかはトグルで
 * 表す。レストランで飲んだ回は `drank=1` + `place_id` の1行になる。
 *
 * 場所は**どの経路でもその場で新規作成できる**。かつては新規登録だけに開き、
 * 編集画面では閉じていた——記録のたびに店を増やせると表記ゆれの店名が
 * 増えるため——が、登録時に場所を入れ損ねると後から作る手段が無くなるため開いた。
 * 表記ゆれの抑制は「同名は作れない」というサーバ側の関門(`prepareNewPlace`)が担う。
 *
 * <form> は含めない。TastingFields と同じく、MCP App のホストのサンドボックス
 * iframe(allow-forms が付かないことがある)と同じ制約に合わせ、保存は submit
 * ではなくボタンの onClick で行う。
 */
export function EncounterFields({
	value,
	onChange,
	places,
	idPrefix,
	disabled,
}: EncounterFieldsProps) {
	const creatingPlace = value.placeId === NEW_PLACE_VALUE;
	// 同名は作れない(サーバの prepareNewPlace が 409 で弾く)。保存を押すまで
	// 分からないと入力をやり直させることになるので、一覧に同じ名前があれば入力中に出す。
	const newPlaceName = value.newPlaceName.trim();
	const duplicateName =
		creatingPlace && places.some((place) => place.name === newPlaceName);
	return (
		<>
			<div className="flex items-center gap-3">
				<Switch
					id={`${idPrefix}-drank`}
					checked={value.drank}
					disabled={disabled}
					onCheckedChange={(checked) => onChange({ drank: checked === true })}
				/>
				<Label htmlFor={`${idPrefix}-drank`}>このとき飲んだ</Label>
			</div>

			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<FormField label="日付" htmlFor={`${idPrefix}-occurred-on`}>
					<Input
						id={`${idPrefix}-occurred-on`}
						type="date"
						value={value.occurredOn}
						disabled={disabled}
						onChange={(e) => onChange({ occurredOn: e.target.value })}
					/>
				</FormField>

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
			</div>

			{value.drank && (
				<FormField label="評価">
					<RatingStarsInput
						value={value.rating}
						onChange={(rating) => onChange({ rating })}
						disabled={disabled}
					/>
				</FormField>
			)}

			<FormField label="その場での価格(円)" htmlFor={`${idPrefix}-price`}>
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
					// 体験記録のメモ上限は飲用側の 2000 を採る(place/schema.ts 参照)
					maxLength={2000}
					rows={4}
					placeholder="味わいの感想やお店の様子など"
				/>
			</FormField>
		</>
	);
}
