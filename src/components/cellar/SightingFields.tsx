import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { PRICE_MAX, PRICE_MIN } from "#/lib/drunk-wine/schema";
import { SIGHTING_MEMO_MAX } from "#/lib/place/schema";
import type { PlaceEntry } from "#/lib/services/place-service";

/** 目撃記録1件のフォーム値。数値は入力途中を表せるよう文字列で持つ(飲用記録と同じ流儀)。 */
export interface WineSightingDraft {
	/** 場所の選択。未選択は "" */
	placeId: string;
	seenOn: string;
	price: string;
	memo: string;
}

export const EMPTY_SIGHTING_DRAFT: WineSightingDraft = {
	placeId: "",
	seenOn: "",
	price: "",
	memo: "",
};

/** 場所を選ばない選択肢の値。空文字は Select が「未選択」と解釈するため使えない。 */
export const NO_PLACE_VALUE = "__none__";

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
 * 場所は**新規作成を持たない**。ここで店を増やせるようにすると、表記ゆれの店名が
 * 目撃記録ごとに増えていく。場所が生まれる経路は一括登録(/cellar/import)に集約し、
 * ここでは既に登録済みの場所から選ぶだけにする。
 */
export function SightingFields({
	value,
	onChange,
	places,
	idPrefix,
	disabled,
}: SightingFieldsProps) {
	return (
		<>
			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-place`}>場所</Label>
					<Select
						value={value.placeId || NO_PLACE_VALUE}
						disabled={disabled || places.length === 0}
						onValueChange={(v) =>
							onChange({ placeId: v === NO_PLACE_VALUE ? "" : v })
						}
					>
						<SelectTrigger id={`${idPrefix}-place`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NO_PLACE_VALUE}>指定しない</SelectItem>
							{places.map((place) => (
								<SelectItem key={place.id} value={place.id}>
									{place.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{places.length === 0 && (
						<p className="text-xs text-muted-foreground">
							場所は「写真からまとめて登録」で作成できます
						</p>
					)}
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-seen-on`}>見かけた日</Label>
					<Input
						id={`${idPrefix}-seen-on`}
						type="date"
						value={value.seenOn}
						disabled={disabled}
						onChange={(e) => onChange({ seenOn: e.target.value })}
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-price`}>その店での価格(円)</Label>
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
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-memo`}>メモ</Label>
				<Textarea
					id={`${idPrefix}-memo`}
					value={value.memo}
					disabled={disabled}
					onChange={(e) => onChange({ memo: e.target.value })}
					maxLength={SIGHTING_MEMO_MAX}
					rows={2}
					placeholder="例: グラスでも提供していた"
				/>
			</div>
		</>
	);
}
