import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { WineReferencesValue } from "#/components/cellar/drunk-wine-payload";
import { WineReferencesEditor } from "#/components/cellar/WineReferencesEditor";
import { Button } from "#/components/ui/button";
import { FormSection } from "#/components/ui/form-section";

// 参考サイト・市場価格の遅延表示セクション(#588)。銘柄に属する参考情報で、
// DrunkWineForm が新規・編集の両方で使う。TastingList / SightingList と同じ形で
// 空のときは折りたたみ(追加ボタン)、値があるときは展開して出す。
//
// TastingList 等と違い保存は銘柄フォームの「記録する/更新する」に載るため、
// ここは表示の出し分けだけを持ち、値の state は親(DrunkWineForm)が持つ。
// 展開後の入力UI自体は WineReferencesEditor に寄せる(出し分けをエディタ側に
// 書くと単体テストの対象が混ざるため)。
export interface WineReferencesSectionProps {
	value: WineReferencesValue;
	onChange: (next: WineReferencesValue) => void;
	/** 入力欄の DOM id の接頭辞(既定 "wine-references")。 */
	idPrefix?: string;
}

export function WineReferencesSection({
	value,
	onChange,
	idPrefix = "wine-references",
}: WineReferencesSectionProps) {
	const hasValues = value.referenceLinks.length > 0 || value.prices.length > 0;
	// 初期値は保存値・引き継ぎで決まる。新規作成の引き継ぎ(initialReferences)が
	// 空でない回は最初から開く(一括登録からの引き継ぎ初期値との兼ね合い)。
	const [open, setOpen] = useState(hasValues);
	// 再解析の確定などで親の値が外部から増えたら開く。閉じていると「足されたのに
	// 見えない」になるため。
	useEffect(() => {
		if (value.referenceLinks.length > 0 || value.prices.length > 0) {
			setOpen(true);
		}
	}, [value.referenceLinks.length, value.prices.length]);

	return (
		<FormSection
			title="参考サイト・市場価格"
			description="AIが裏取りに使ったページや見つけた価格です。必要なら追加できます"
			action={
				!open ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setOpen(true)}
					>
						<PlusIcon className="size-4" aria-hidden />
						参考情報を追加
					</Button>
				) : (
					// 空のまま開いた回だけ閉じられる。値があるときは隠さない。
					!hasValues && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setOpen(false)}
						>
							閉じる
						</Button>
					)
				)
			}
		>
			{!open ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-6">
					<LinkIcon className="size-6 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ参考サイト・市場価格がありません。
					</p>
				</div>
			) : (
				<WineReferencesEditor
					value={value}
					onChange={onChange}
					idPrefix={idPrefix}
				/>
			)}
		</FormSection>
	);
}
