import {
	ChevronDownIcon,
	ChevronUpIcon,
	InfoIcon,
	LinkIcon,
} from "lucide-react";
import { useState } from "react";
import { DrunkWineFields } from "#/components/cellar/DrunkWineFields";
import type {
	DrunkWineFieldsValue,
	WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import type { ImportCardState } from "#/components/cellar/import-candidates";
import {
	PriceList,
	ReferenceLinksList,
} from "#/components/cellar/ReferenceLinksList";
import { TastingFields } from "#/components/cellar/TastingFields";
import { WebPhotoBadge } from "#/components/cellar/WebPhotoBadge";
import { ZoomablePhoto } from "#/components/cellar/WinePhotoGallery";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { FormField } from "#/components/ui/form-section";
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
	// WEB画像の表示は「新規作成する web 由来の銘柄」だけに出す(IMPL-4)。
	// 既存一致のカードは目撃記録を足すだけで web 画像を取り込まないので、
	// imageUrl を持っていても overlay・サムネイルは出さない。
	// 由来の判定は card.photoKind の1箇所だけを見る(ここで有無判定を書き直さない)。
	const showWebPhoto =
		!card.existing && card.photoKind === "web" && !!card.imageUrl;

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
					{/*
					 * WEB由来の銘柄のサムネイル(IMPL-4)。登録前に取り込む画像そのものを
					 * 見せ、左上の overlay で由来を示す(タップで拡大。`ZoomablePhoto` と
					 * 同じ挙動)。手元写真の銘柄のサムネイルは(5)の選択規則とあわせて
					 * 導入するため、ここでは出さない。
					 */}
					{showWebPhoto && (
						<ZoomablePhoto
							src={card.imageUrl as string}
							alt={`${title}の写真`}
							isWebPhoto
							referrerPolicy="no-referrer"
							className="size-16"
						/>
					)}
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
							{/*
							 * 銘柄の写真をどう用意するか(#473)。撮った写真にこの1本だけを写した
							 * ものが無い銘柄は web から取りに行くので、**登録前に分かる形にする**
							 * (知らないうちに外部の画像が自分のセラーに入るのは避ける)。
							 * バッジは共通の `WebPhotoBadge` から出す(IMPL-4。文言「WEB」で統一)。
							 */}
							{showWebPhoto && <WebPhotoBadge variant="inline" />}
							{/*
							 * 画像と実物のズレの注記(IMPL-4。例: 別ヴィンテージの画像)。
							 * バッジの近傍に置き、全文は title で読めるようにする。
							 */}
							{showWebPhoto && card.imageNote && (
								<span
									className="inline-flex max-w-48 items-center gap-1 rounded bg-muted px-1.5 py-0.5"
									title={card.imageNote}
								>
									<InfoIcon className="size-3 shrink-0" aria-hidden />
									<span className="truncate">{card.imageNote}</span>
									<span className="sr-only">(画像の注記:{card.imageNote})</span>
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

						<FormField
							label="この店での価格(円)"
							htmlFor={`${card.localId}-sighting-price`}
							description="目撃記録として保存します(店ごとに違うため、銘柄の価格とは別に持ちます)"
						>
							<Input
								id={`${card.localId}-sighting-price`}
								type="number"
								inputMode="numeric"
								min={0}
								value={card.sightingPrice}
								onChange={(e) => onChange({ sightingPrice: e.target.value })}
								placeholder="例: 12000"
							/>
						</FormField>

						{/*
						 * 解析で裏取りした参考サイト・複数ソースの価格(IMPL-3)。
						 * 差分ダイアログと同じ共通コンポーネントから出す(表示のドリフト防止)。
						 * フォームには流し込まない(参考情報のため)。
						 */}
						{(card.referenceLinks?.length ?? 0) > 0 && (
							<ReferenceLinksList links={card.referenceLinks ?? []} />
						)}
						{(card.prices?.length ?? 0) > 0 && (
							<PriceList prices={card.prices ?? []} />
						)}

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
							</div>{" "}
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
