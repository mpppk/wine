import type { WineTastingDraft } from "#/components/cellar/drunk-wine-payload";
import { RatingStarsInput } from "#/components/cellar/RatingStarsInput";
import { FormField } from "#/components/ui/form-section";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";

export interface TastingFieldsProps {
	value: WineTastingDraft;
	/** 変更のあったキーだけを渡す。呼び出し側が state にマージする。 */
	onChange: (patch: Partial<WineTastingDraft>) => void;
	/** DOM id の接頭辞。同一ページに複数の飲用記録フォームが並ぶため必須 */
	idPrefix: string;
	disabled?: boolean;
}

/**
 * 飲用記録1件の入力項目(飲んだ日 / 評価 / メモ)。
 *
 * 銘柄の入力(DrunkWineFields)とは別のコンポーネントにしている。飲用記録は銘柄に
 * 対して 1:N で、新規追加・編集・削除の単位が銘柄と異なるため(Issue #195)。
 * Web版フォームと MCP App の両方がこれを使い、値の行き先だけが違う
 * (Web は飲用記録の server fn、MCP App は update_drunk_wine のレガシー引数)。
 *
 * <form> は含めない。MCP App はホストのサンドボックス iframe(allow-forms が
 * 付かないことがある)の中で動くため、保存は submit ではなくボタンの onClick で行う。
 */
export function TastingFields({
	value,
	onChange,
	idPrefix,
	disabled,
}: TastingFieldsProps) {
	return (
		<>
			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<FormField label="飲んだ日" htmlFor={`${idPrefix}-drank-on`}>
					<Input
						id={`${idPrefix}-drank-on`}
						type="date"
						value={value.drankOn}
						disabled={disabled}
						onChange={(e) => onChange({ drankOn: e.target.value })}
					/>
				</FormField>

				<FormField label="評価">
					<RatingStarsInput
						value={value.rating}
						onChange={(rating) => onChange({ rating })}
						disabled={disabled}
					/>
				</FormField>
			</div>

			<FormField label="メモ" htmlFor={`${idPrefix}-memo`}>
				<Textarea
					id={`${idPrefix}-memo`}
					value={value.memo}
					disabled={disabled}
					onChange={(e) => onChange({ memo: e.target.value })}
					placeholder="味わいの感想、合わせた料理など"
					maxLength={2000}
					rows={4}
				/>
			</FormField>
		</>
	);
}
