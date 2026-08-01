import { ChevronDownIcon, ChevronUpIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { DrunkWineFields } from "#/components/cellar/DrunkWineFields";
import type {
	DrunkWineFieldsValue,
	WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import type { ImportCardState } from "#/components/cellar/import-candidates";
import { TastingFields } from "#/components/cellar/TastingFields";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";

export interface ImportCandidateCardProps {
	card: ImportCardState;
	/** 変更のあったキーだけを渡す。呼び出し側が state にマージする */
	onChange: (patch: Partial<ImportCardState>) => void;
	/** 銘柄の入力値の変更(既存一致の解除を伴うので専用の口にする) */
	onChangeValues: (patch: Partial<DrunkWineFieldsValue>) => void;
}

/**
 * レビュー画面(/cellar/import の Step 2)の銘柄カード1件。
 *
 * 折りたたみを既定にしているのは、この画面には数十件のカードが並ぶため。
 * 展開すると銘柄の入力項目一式(DrunkWineFields)が出る——**カード用に簡易フォームを
 * 作らない**のが要点で、入力仕様を別実装すると #185 と同じドリフトが起きる。
 */
export function ImportCandidateCard({
	card,
	onChange,
	onChangeValues,
}: ImportCandidateCardProps) {
	const [expanded, setExpanded] = useState(false);
	const title = card.values.name.trim() || "(名前未読取)";
	const detail = [
		card.values.producer.trim(),
		card.values.vintage.trim(),
		card.sightingPrice.trim() &&
			`${Number(card.sightingPrice).toLocaleString("ja-JP")}円`,
	]
		.filter(Boolean)
		.join(" / ");

	return (
		<Card className={card.selected ? undefined : "opacity-60"}>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-start gap-3">
					<Checkbox
						id={`${card.localId}-selected`}
						checked={card.selected}
						onCheckedChange={(checked) =>
							onChange({ selected: checked === true })
						}
						className="mt-1"
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<Label
							htmlFor={`${card.localId}-selected`}
							className="cursor-pointer text-base font-medium"
						>
							{title}
						</Label>
						{detail && (
							<p className="truncate text-sm text-muted-foreground">{detail}</p>
						)}
						<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							{card.photoIndexes.length > 0 && (
								<span className="rounded bg-muted px-1.5 py-0.5">
									{card.photoIndexes.map((i) => `${i + 1}枚目`).join("・")}
								</span>
							)}
							<span className="rounded bg-muted px-1.5 py-0.5">
								{WINE_STATUS_LABELS_JA[card.values.status]}
							</span>
							{card.existing && (
								<span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary">
									<LinkIcon className="size-3" aria-hidden />
									既存の「{card.existing.name}
									{card.existing.vintage ? ` ${card.existing.vintage}` : ""}
									」に目撃を追加
								</span>
							)}
						</div>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-expanded={expanded}
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? (
							<ChevronUpIcon className="size-4" aria-hidden />
						) : (
							<ChevronDownIcon className="size-4" aria-hidden />
						)}
						{expanded ? "閉じる" : "編集"}
					</Button>
				</div>

				{expanded && (
					<div className="flex flex-col gap-6 border-t border-border pt-4">
						{card.existing && (
							<p className="text-xs text-muted-foreground">
								既存のエントリに目撃記録を追加します。銘柄の内容を編集すると、
								既存への追加をやめて新しく登録します。
							</p>
						)}
						<DrunkWineFields
							value={card.values}
							onChange={onChangeValues}
							idPrefix={card.localId}
						/>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${card.localId}-sighting-price`}>
								この店での価格(円)
							</Label>
							<Input
								id={`${card.localId}-sighting-price`}
								type="number"
								inputMode="numeric"
								min={0}
								value={card.sightingPrice}
								onChange={(e) => onChange({ sightingPrice: e.target.value })}
								placeholder="例: 12000"
							/>
							<p className="text-xs text-muted-foreground">
								目撃記録として保存します(店ごとに違うため、銘柄の価格とは別に持ちます)
							</p>
						</div>

						<fieldset className="flex flex-col gap-3">
							<div className="flex items-center gap-3">
								<Switch
									id={`${card.localId}-drunk`}
									checked={card.drunk}
									onCheckedChange={(checked) => onChange({ drunk: checked })}
								/>
								<Label htmlFor={`${card.localId}-drunk`}>
									このワインを飲んだ
								</Label>
							</div>
							{card.drunk && (
								<TastingFields
									value={card.tasting}
									onChange={(patch: Partial<WineTastingDraft>) =>
										onChange({ tasting: { ...card.tasting, ...patch } })
									}
									idPrefix={`${card.localId}-tasting`}
								/>
							)}
						</fieldset>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
