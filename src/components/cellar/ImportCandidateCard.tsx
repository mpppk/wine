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
	dialogIndexForDisplayPhoto,
	displayPhotoForImportCard,
	photosForImportCardDialog,
	primarySelectionForDialogIndex,
} from "#/components/cellar/import-candidates";
import { PhotoLightbox } from "#/components/cellar/PhotoLightbox";
import {
	PriceList,
	ReferenceLinksList,
} from "#/components/cellar/ReferenceLinksList";
import { TastingFields } from "#/components/cellar/TastingFields";
import { WebPhotoBadge } from "#/components/cellar/WebPhotoBadge";
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
	/**
	 * 解析に渡した順のバッチ写真のプレビューURL(IMPL-5)。カードの手元写真の
	 * サムネイルに使う。受け取って開いた回は手元に写真が無いので空配列——
	 * その場合は手元写真のサムネイルが出ない(web 画像は URL 参照なので出る)。
	 */
	photoPreviews: readonly string[];
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
	photoPreviews,
	onChange,
	onChangeValues,
}: ImportCandidateCardProps) {
	const [expanded, setExpanded] = useState(false);
	const [noteOpen, setNoteOpen] = useState(false);
	const title = card.values.name.trim() || "(名前未読取)";
	const detail = [
		card.values.producer.trim(),
		card.values.vintage.trim(),
		card.sightingPrice.trim() &&
			`${Number(card.sightingPrice).toLocaleString("ja-JP")}円`,
	]
		.filter(Boolean)
		.join(" / ");
	// カードに表示する利用画像(IMPL-5)。選ぶ規則は `displayPhotoForImportCard` の
	// 1箇所だけに寄せる(ここで有無判定を書き直すと表示と登録で食い違う):
	// 新規作成する web 由来の銘柄は web 画像、それ以外は手元のバッチ写真から
	// 登録時に使われる1枚と同じものを自動選択する。由来の判定も結果の
	// `isWebPhoto` だけを見る(card.photoKind を直接見ない)。
	const displayPhoto = displayPhotoForImportCard(card, photoPreviews);
	const showWebPhoto = displayPhoto?.isWebPhoto === true;
	// タップダイアログに出す関連写真。サムネイル(自動選択または代表の上書き)を
	// 含むことが保証されているので、開く位置がずれない。
	const dialogPhotos = photosForImportCardDialog(card, photoPreviews);
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	const thumbnailLabel = `${title}の写真${showWebPhoto ? "(WEB画像)" : ""}を拡大`;

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
					 * 利用画像のサムネイル(IMPL-5 + #568)。登録前に取り込む画像そのものを
					 * 見せ、WEB由来のものだけ左上の overlay で由来を示す。タップで関連写真
					 * のダイアログを開き、切り替えて見比べたうえで「代表画像として選択」
					 * できる。選んだ写真はこのカードのサムネイルに使う(登録ペイロードの
					 * 目撃写真番号は変えない——表示専用の上書き)。登録されるのは関連写真
					 * のすべて(#574)で、サムネイルはそのうちの代表1枚という位置づけ。
					 */}
					{displayPhoto && (
						<>
							<button
								type="button"
								onClick={() =>
									setLightboxIndex(
										dialogIndexForDisplayPhoto(card, photoPreviews),
									)
								}
								aria-label={thumbnailLabel}
								className="relative size-16 shrink-0 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
							>
								<img
									src={displayPhoto.src}
									alt=""
									className="size-full object-cover"
									loading="lazy"
									decoding="async"
									{...(showWebPhoto ? { referrerPolicy: "no-referrer" } : {})}
								/>
								{showWebPhoto && <WebPhotoBadge variant="overlay" />}
							</button>
							{dialogPhotos.length > 0 && (
								<PhotoLightbox
									photos={dialogPhotos.map((photo) => ({
										src: photo.src,
										alt: `${title}の写真${photo.isWebPhoto ? "(WEB画像)" : ""}`,
									}))}
									openIndex={lightboxIndex}
									onOpenChange={setLightboxIndex}
									title={`${title}の写真`}
									primarySelect={{
										selectedIndex: dialogIndexForDisplayPhoto(
											card,
											photoPreviews,
										),
										onSelect: (dialogIndex) => {
											const selection = primarySelectionForDialogIndex(
												card,
												photoPreviews,
												dialogIndex,
											);
											if (selection) onChange({ primaryPhoto: selection });
										},
									}}
								/>
							)}
						</>
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
							{/*
							 * 写真の由来はサムネイルの overlay(WebPhotoBadge)で示すため、
							 * 文字バッジ(何枚目・WEB画像)は出さない。
							 */}
							{/*
							 * 画像と実物のズレの注記(IMPL-4。例: 別ヴィンテージの画像)。
							 * 一覧性を損なわないようアイコンのみ出し、hover(title)・
							 * タップ(展開)・読み上げ(aria-label)で全文を読めるようにする。
							 */}
							{showWebPhoto && card.imageNote && (
								<span className="inline-flex items-center gap-1">
									<button
										type="button"
										className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
										title={card.imageNote}
										aria-label={`画像の注記: ${card.imageNote}`}
										aria-expanded={noteOpen}
										onClick={() => setNoteOpen((v) => !v)}
									>
										<InfoIcon className="size-3" aria-hidden />
									</button>
									{noteOpen && (
										<span className="text-xs text-muted-foreground">
											{card.imageNote}
										</span>
									)}
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
									飲んだ記録を追加
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
