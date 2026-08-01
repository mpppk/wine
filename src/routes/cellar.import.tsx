import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, SparklesIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { ImportCandidateCard } from "#/components/cellar/ImportCandidateCard";
import {
	buildBulkRegisterInput,
	buildImportCards,
	detachExisting,
	type ImportCardState,
	summarizeImportCards,
	validateImportCards,
} from "#/components/cellar/import-candidates";
import { UnsavedChangesGuard } from "#/components/cellar/UnsavedChangesGuard";
import {
	analyzeWineListPhotos,
	uploadImportBatchPhotos,
} from "#/components/cellar/wine-list-analysis";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { LiveRegion } from "#/components/ui/live-region";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { TAP_TARGET_44 } from "#/lib/a11y";
import { CREDIT_BALANCE_QUERY_KEY } from "#/lib/credit/use-credit";
import { todayCalendarDate } from "#/lib/date/calendar-date";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	PHOTO_ACCEPT_ATTR,
	PHOTO_FORMATS_LABEL_JA,
} from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import type { WineListAnalysisSummary } from "#/lib/services/ai-service";
import { cn } from "#/lib/utils";
import { getWineListAnalysisAvailability } from "#/server/ai";
import { bulkRegisterFromScan, listPlaces } from "#/server/place";

// 写真からのワイン一括登録ウィザード(Issue #358)。3ステップ:
//  1. 撮影/選択 — 写真(≤10枚)+ 場所 + 見かけた日 → 解析(AIクレジットを消費)
//  2. レビュー — 検出した銘柄をカードで確認・編集・取捨選択
//  3. 確定 — bulkRegisterFromScan(原子的)→ 写真の実体をアップロード
//
// AIクレジットを使うのは Step 1 の解析だけ。Step 2 の内容を失うと**やり直しに
// クレジットがもう一度かかる**ので、離脱ガードを必ず出す(#238 と同じ理由)。

const NEW_PLACE = "__new__";
const NO_PLACE = "__none__";

export const Route = createFileRoute("/cellar/import")({
	beforeLoad: requireAuthBeforeLoad,
	loader: async () => {
		const [places, availability] = await Promise.all([
			listPlaces(),
			getWineListAnalysisAvailability(),
		]);
		return { places, availability };
	},
	component: CellarImportPage,
});

/** 選択中の写真1枚。プレビューURLは解放が要るので localId で同定する。 */
interface PhotoItem {
	localId: string;
	file: File;
	previewUrl: string;
}

function CellarImportPage() {
	const { places, availability } = Route.useLoaderData();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [photos, setPhotos] = useState<PhotoItem[]>([]);
	const [placeChoice, setPlaceChoice] = useState<string>(NO_PLACE);
	const [newPlaceName, setNewPlaceName] = useState("");
	const [seenOn, setSeenOn] = useState(() => todayCalendarDate());
	const [cards, setCards] = useState<ImportCardState[] | null>(null);
	const [summary, setSummary] = useState<WineListAnalysisSummary | null>(null);
	const [error, setError] = useState("");
	const [showInsufficient, setShowInsufficient] = useState(false);
	const newIdRef = useRef(0);
	const doneRef = useRef(false);

	const updateCard = (localId: string, patch: Partial<ImportCardState>) => {
		setCards(
			(prev) =>
				prev?.map((c) => (c.localId === localId ? { ...c, ...patch } : c)) ??
				null,
		);
	};

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		e.target.value = "";
		if (files.length === 0) return;
		const accepted: PhotoItem[] = [];
		let rejectMsg = "";
		let remaining = MAX_PHOTOS_PER_IMPORT_BATCH - photos.length;
		for (const file of files) {
			// サーバ側の 400 を待たずに弾く(制約は photo.ts / place/schema.ts と共通)
			if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
				rejectMsg = `対応していない画像形式です(${PHOTO_FORMATS_LABEL_JA})`;
				continue;
			}
			if (file.size > MAX_PHOTO_BYTES) {
				rejectMsg = `写真は${MAX_PHOTO_SIZE_LABEL}以下にしてください`;
				continue;
			}
			if (remaining <= 0) {
				rejectMsg = `写真は最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚までです`;
				continue;
			}
			accepted.push({
				localId: `p${newIdRef.current++}`,
				file,
				previewUrl: URL.createObjectURL(file),
			});
			remaining -= 1;
		}
		setError(rejectMsg);
		if (accepted.length > 0) setPhotos((prev) => [...prev, ...accepted]);
	};

	const removePhoto = (localId: string) => {
		setPhotos((prev) => {
			const target = prev.find((p) => p.localId === localId);
			if (target) URL.revokeObjectURL(target.previewUrl);
			return prev.filter((p) => p.localId !== localId);
		});
	};

	const { mutate: analyze, isPending: isAnalyzing } = useMutation({
		mutationFn: () => analyzeWineListPhotos(photos.map((p) => p.file)),
		onSuccess: (result) => {
			// クレジットを消費するのでヘッダ等の残高表示を更新する
			void queryClient.invalidateQueries({
				queryKey: CREDIT_BALANCE_QUERY_KEY,
			});
			if (result.blocked) {
				setShowInsufficient(true);
				return;
			}
			setCards(buildImportCards(result.candidates));
			setSummary(result.summary);
			if (result.candidates.length === 0) {
				setError(
					"写真からワインを読み取れませんでした。ワインリストや棚が写るように撮り直してください。",
				);
			}
		},
		onError: (e: Error) => setError(e.message || "写真の解析に失敗しました"),
	});

	const { mutate: register, isPending: isRegistering } = useMutation({
		mutationFn: async () => {
			if (!cards) throw new Error("解析結果がありません");
			const result = await bulkRegisterFromScan({
				data: buildBulkRegisterInput(cards, {
					...(placeChoice !== NO_PLACE && placeChoice !== NEW_PLACE
						? { placeId: placeChoice }
						: {}),
					...(placeChoice === NEW_PLACE ? { newPlaceName } : {}),
					...(seenOn ? { seenOn } : {}),
					photoCount: photos.length,
				}),
			});
			// 写真の実体は登録確定後(R2キーが batchId 依存)。ここで失敗しても登録済みの
			// 記録は残るので、写真だけが無い状態として扱い、エラーは伝えるだけにする。
			await uploadImportBatchPhotos(
				result.batchId,
				photos.map((p) => p.file),
			);
			return result;
		},
		onSuccess: async (result) => {
			for (const p of photos) URL.revokeObjectURL(p.previewUrl);
			doneRef.current = true;
			await navigate({ to: "/cellar", search: { filter: "spotted" } });
			void result;
		},
		onError: (e: Error) => setError(e.message || "登録に失敗しました"),
	});

	if (!availability.available) {
		return (
			<main className="mx-auto max-w-2xl px-4 py-10">
				<PageHeader />
				<p className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
					この環境では写真からの一括登録を利用できません。
				</p>
			</main>
		);
	}

	const selection = cards ? summarizeImportCards(cards) : null;
	const validation = cards ? validateImportCards(cards) : null;

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<PageHeader />

			{cards === null ? (
				<div className="flex flex-col gap-6">
					<div className="flex flex-col gap-3">
						<Label htmlFor="import-photo">
							写真(最大{MAX_PHOTOS_PER_IMPORT_BATCH}枚)
						</Label>
						{photos.length > 0 && (
							<ul className="flex flex-wrap gap-3">
								{photos.map((p, index) => (
									<li
										key={p.localId}
										className="relative h-24 w-24 rounded-md border border-border"
									>
										<img
											src={p.previewUrl}
											alt={`写真${index + 1}`}
											className="h-full w-full rounded-md object-cover"
											width={96}
											height={96}
										/>
										<span className="absolute left-1 top-1 rounded bg-foreground/80 px-1 py-0.5 text-[10px] font-medium leading-none text-background">
											{index + 1}枚目
										</span>
										<button
											type="button"
											aria-label={`写真${index + 1}を削除`}
											onClick={() => removePhoto(p.localId)}
											className={cn(
												"absolute right-1 top-1 rounded-full bg-foreground/70 p-1 text-background transition-colors hover:bg-foreground",
												TAP_TARGET_44,
											)}
										>
											<XIcon className="size-4" aria-hidden />
										</button>
									</li>
								))}
							</ul>
						)}
						<Input
							id="import-photo"
							type="file"
							accept={PHOTO_ACCEPT_ATTR}
							multiple
							onChange={handleFileChange}
							disabled={photos.length >= MAX_PHOTOS_PER_IMPORT_BATCH}
							className="max-w-xs"
						/>
						<p className="text-xs text-muted-foreground">
							レストランのワインリストやショップの棚を撮った写真を選んでください。
							{PHOTO_FORMATS_LABEL_JA}、各{MAX_PHOTO_SIZE_LABEL}まで。
							同じワインが複数の写真に写っていても1件にまとめます。
						</p>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="import-place">見かけた場所(任意)</Label>
						<Select value={placeChoice} onValueChange={setPlaceChoice}>
							<SelectTrigger id="import-place" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NO_PLACE}>指定しない</SelectItem>
								<SelectItem value={NEW_PLACE}>新しい場所を追加…</SelectItem>
								{places.map((place) => (
									<SelectItem key={place.id} value={place.id}>
										{place.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{placeChoice === NEW_PLACE && (
							<Input
								aria-label="新しい場所の名前"
								value={newPlaceName}
								onChange={(e) => setNewPlaceName(e.target.value)}
								placeholder="例: ビストロ・ド・パリ 渋谷店"
								maxLength={100}
								className="mt-2"
							/>
						)}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="import-seen-on">見かけた日</Label>
						<Input
							id="import-seen-on"
							type="date"
							value={seenOn}
							onChange={(e) => setSeenOn(e.target.value)}
							className="max-w-xs"
						/>
					</div>

					<LiveRegion tone="alert" className="empty:-mt-6">
						{error && <p className="text-sm text-destructive">{error}</p>}
					</LiveRegion>

					<div className="flex flex-col gap-1">
						<Button
							type="button"
							className="self-start"
							disabled={
								photos.length === 0 ||
								isAnalyzing ||
								(placeChoice === NEW_PLACE && !newPlaceName.trim())
							}
							onClick={() => {
								setError("");
								analyze();
							}}
						>
							<SparklesIcon className="size-4" aria-hidden />
							{isAnalyzing ? "解析中…" : "写真を解析する"}
						</Button>
						<p className="text-xs text-muted-foreground">
							AIが写真からワインを読み取ります(AIクレジットを消費)。枚数が多いほど消費が増えます。
						</p>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{summary && (
						<div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
							<p>
								{summary.detected}銘柄を検出しました
								{summary.mergedDuplicates > 0 &&
									`(重複${summary.mergedDuplicates}件を統合`}
								{summary.mergedDuplicates > 0 &&
									summary.matchedExisting > 0 &&
									"・"}
								{summary.mergedDuplicates === 0 &&
									summary.matchedExisting > 0 &&
									"("}
								{summary.matchedExisting > 0 &&
									`既存セラーと${summary.matchedExisting}件一致`}
								{(summary.mergedDuplicates > 0 ||
									summary.matchedExisting > 0) &&
									")"}
							</p>
							{summary.truncated && (
								<p className="mt-1 text-destructive">
									銘柄が多すぎて、すべてを読み取れなかった可能性があります。写真を分けて解析し直すと残りを登録できます。
								</p>
							)}
						</div>
					)}

					{cards.map((card) => (
						<ImportCandidateCard
							key={card.localId}
							card={card}
							onChange={(patch) => updateCard(card.localId, patch)}
							onChangeValues={(patch: Partial<DrunkWineFieldsValue>) =>
								setCards(
									(prev) =>
										prev?.map((c) =>
											c.localId === card.localId
												? // 銘柄を編集したら既存一致は外す(表示と実際の動作を一致させる)
													detachExisting({
														...c,
														values: { ...c.values, ...patch },
													})
												: c,
										) ?? null,
								)
							}
						/>
					))}

					<LiveRegion tone="alert" className="empty:-mt-4">
						{error && <p className="text-sm text-destructive">{error}</p>}
					</LiveRegion>

					<div className="sticky bottom-0 flex flex-col gap-1 border-t border-border bg-background py-4">
						{selection && (
							<p className="text-sm text-muted-foreground">
								{selection.selected}件を登録します(新規{selection.create}
								件・既存へ追加
								{selection.attach}件
								{selection.drunk > 0 && `・飲んだ記録${selection.drunk}件`})
							</p>
						)}
						<div className="flex gap-2">
							<Button
								type="button"
								disabled={isRegistering || !!validation}
								onClick={() => {
									setError("");
									register();
								}}
							>
								{isRegistering ? "登録中…" : "マイセラーに登録する"}
							</Button>
							<Button
								type="button"
								variant="ghost"
								disabled={isRegistering}
								onClick={() => {
									setCards(null);
									setSummary(null);
									setError("");
								}}
							>
								写真の選択に戻る
							</Button>
						</div>
						{validation && (
							<p className="text-xs text-destructive">{validation}</p>
						)}
					</div>
				</div>
			)}

			<InsufficientCreditsDialog
				open={showInsufficient}
				onOpenChange={setShowInsufficient}
			/>

			{/* 解析はクレジットを消費しているので、レビュー中の離脱は必ず警告する(#238) */}
			<UnsavedChangesGuard
				shouldBlock={() => !doneRef.current && cards !== null}
			/>
		</main>
	);
}

function PageHeader() {
	return (
		<div className="mb-6 flex items-center gap-2">
			<Button asChild variant="ghost" size="icon" aria-label="マイセラーへ戻る">
				<Link to="/cellar">
					<ArrowLeftIcon className="size-4" />
				</Link>
			</Button>
			<h1 className="text-2xl font-bold">写真からまとめて登録</h1>
		</div>
	);
}
