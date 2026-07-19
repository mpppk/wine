import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckIcon,
	ChevronsUpDownIcon,
	SparklesIcon,
	StarIcon,
	XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
	type AnalysisPhotoSource,
	analyzeLabelPhotos,
} from "#/components/cellar/label-analysis";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
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
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import { CREDIT_BALANCE_QUERY_KEY } from "#/lib/credit/use-credit";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTOS_PER_ENTRY,
	PHOTO_ACCEPT_ATTR,
} from "#/lib/drunk-wine/photo";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { cn } from "#/lib/utils";
import { getAop, listAops, listRegions } from "#/lib/wine/service";
import { GRAPE_VARIETIES } from "#/lib/wine/varieties";
import { createDrunkWine, updateDrunkWine } from "#/server/drunk-wine";

const REGION_NONE = "__none__";

export interface DrunkWineFormProps {
	/** 既存エントリ(編集時)。未指定なら新規作成 */
	entry?: DrunkWineEntry;
	/** 保存(写真アップロードを含む)が完了したエントリを受け取る */
	onSaved: (entry: DrunkWineEntry) => void | Promise<void>;
}

// フォームが扱う写真1枚。既存はR2キー保持、新規はローカルFile+プレビューURL。
// localId はReactのkeyと並べ替え・削除の同定に使う(表示順は配列順)。
type PhotoItem =
	| { localId: string; kind: "existing"; key: string }
	| { localId: string; kind: "new"; file: File; previewUrl: string };

/** 相対 photoUrl(/api/images/{key})から R2キーを復元する(DTOのURLはクエリを持たない)。 */
function photoKeyFromUrl(url: string): string {
	return url.replace(/^\/api\/images\//, "");
}

/**
 * 現在の写真集合(表示順)を /api/wine-photos へ送り全置換で同期する。
 * 新規Fileは "photo" として順に送り、layout がその index を指す。
 */
async function syncPhotos(
	entryId: string,
	photos: PhotoItem[],
): Promise<DrunkWineEntry> {
	const form = new FormData();
	form.append("entryId", entryId);
	const newIndex = new Map<string, number>();
	let i = 0;
	for (const p of photos) {
		if (p.kind === "new") {
			form.append("photo", p.file);
			newIndex.set(p.localId, i);
			i += 1;
		}
	}
	const layout = photos.map((p) =>
		p.kind === "existing"
			? { type: "existing", key: p.key }
			: { type: "new", index: newIndex.get(p.localId) },
	);
	form.append("layout", JSON.stringify(layout));
	const res = await fetch("/api/wine-photos", { method: "POST", body: form });
	const body = (await res.json()) as { error?: string; entry?: DrunkWineEntry };
	if (!res.ok || !body.entry) {
		throw new Error(body.error ?? "写真のアップロードに失敗しました");
	}
	return body.entry;
}

// 追加/編集共用のフォーム。作成と更新でserver fnのnull/undefined規約が
// 異なる(更新は null=クリア)ため、送信ペイロードだけ分岐する。
// 写真は複数枚。エントリ確定後でないとR2キー(entryId依存)が決まらないので、
// server fn成功後に /api/wine-photos へ写真集合を同期POSTする(追加・削除・並べ替えを一括反映)。
export function DrunkWineForm({ entry, onSaved }: DrunkWineFormProps) {
	const [name, setName] = useState(entry?.name ?? "");
	const [drankOn, setDrankOn] = useState(entry?.drankOn ?? "");
	const [rating, setRating] = useState<number | null>(entry?.rating ?? null);
	const [vintage, setVintage] = useState(
		entry?.vintage != null ? String(entry.vintage) : "",
	);
	const [producer, setProducer] = useState(entry?.producer ?? "");
	const [price, setPrice] = useState(
		entry?.price != null ? String(entry.price) : "",
	);
	const [memo, setMemo] = useState(entry?.memo ?? "");
	const [regionId, setRegionId] = useState<string | undefined>(
		entry?.regionId ?? undefined,
	);
	const [aopId, setAopId] = useState<string | undefined>(
		entry?.aopId ?? undefined,
	);
	const [grapeVarietyIds, setGrapeVarietyIds] = useState<string[]>(
		entry?.grapeVarietyIds ?? [],
	);
	const [aopPickerOpen, setAopPickerOpen] = useState(false);
	// 写真は複数枚。表示順=配列順、先頭が代表(サムネイル)。既存写真はキーで保持する
	const [photos, setPhotos] = useState<PhotoItem[]>(() =>
		(entry?.photoUrls ?? []).map((url, i) => ({
			localId: `e${i}`,
			kind: "existing" as const,
			key: photoKeyFromUrl(url),
		})),
	);
	const [error, setError] = useState("");
	const [analyzeNotice, setAnalyzeNotice] = useState("");
	const [showInsufficient, setShowInsufficient] = useState(false);
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	// 新規写真の localId 採番用(既存は e{i}、新規は n{連番})
	const newIdRef = useRef(0);
	// 新規作成でエントリ作成後に写真アップロードだけ失敗した場合、
	// 再送信で重複エントリを作らないよう作成済みエントリを覚えて更新に切り替える
	const createdRef = useRef<DrunkWineEntry | null>(null);

	const regions = useMemo(() => listRegions().filter((r) => r.enabled), []);
	const aopCandidates = useMemo(
		() => (regionId ? listAops({ regionId }) : []),
		[regionId],
	);
	const selectedAop = aopId ? getAop(aopId) : undefined;
	const redVarieties = GRAPE_VARIETIES.filter((v) => v.color === "red");
	const whiteVarieties = GRAPE_VARIETIES.filter((v) => v.color === "white");

	const toggleVariety = (id: string) => {
		setGrapeVarietyIds((prev) =>
			prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
		);
	};

	// 既存写真の表示URL(キャッシュバスタ付き)。解析時のfetchにも使う
	const photoSrc = (p: PhotoItem): string =>
		p.kind === "new"
			? p.previewUrl
			: `/api/images/${p.key}?v=${entry?.updatedAt ?? ""}`;

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		// 同じファイルを続けて選べるよう、また選択と実アップロードが乖離しないよう毎回リセット
		e.target.value = "";
		if (files.length === 0) return;

		const accepted: PhotoItem[] = [];
		let rejectMsg = "";
		let remaining = MAX_PHOTOS_PER_ENTRY - photos.length;
		for (const file of files) {
			// サーバ側の 400 を待たずに弾く(制約は photo.ts と共通)
			if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
				rejectMsg = "対応していない画像形式です(JPEG/PNG/WebP/GIF)";
				continue;
			}
			if (file.size > MAX_PHOTO_BYTES) {
				rejectMsg = "写真は5MB以下にしてください";
				continue;
			}
			if (remaining <= 0) {
				rejectMsg = `写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです`;
				continue;
			}
			accepted.push({
				localId: `n${newIdRef.current++}`,
				kind: "new",
				file,
				previewUrl: URL.createObjectURL(file),
			});
			remaining -= 1;
		}
		setError(rejectMsg);
		setAnalyzeNotice("");
		if (accepted.length > 0) setPhotos((prev) => [...prev, ...accepted]);
	};

	const removePhoto = (localId: string) => {
		setPhotos((prev) => {
			const target = prev.find((p) => p.localId === localId);
			if (target?.kind === "new") URL.revokeObjectURL(target.previewUrl);
			return prev.filter((p) => p.localId !== localId);
		});
		setError("");
	};

	// 表示順の入れ替え(隣と交換)。dir=-1で前へ、+1で後ろへ
	const movePhoto = (localId: string, dir: -1 | 1) => {
		setPhotos((prev) => {
			const i = prev.findIndex((p) => p.localId === localId);
			const j = i + dir;
			if (i < 0 || j < 0 || j >= prev.length) return prev;
			const next = [...prev];
			[next[i], next[j]] = [next[j], next[i]] as [PhotoItem, PhotoItem];
			return next;
		});
	};

	// エチケット解析の候補を「未入力の項目だけ」に反映する(ユーザ入力は上書きしない)。
	// AOPはフォームの地域絞り込みと整合するよう、地域が未選択なら候補の地域も併せて
	// 設定し、別の地域が選択済みなら適用しない。
	const applySuggestions = (s: LabelSuggestions): string[] => {
		const filled: string[] = [];
		if (s.name && !name.trim()) {
			setName(s.name);
			filled.push("名前");
		}
		if (s.producer && !producer.trim()) {
			setProducer(s.producer);
			filled.push("生産者");
		}
		if (s.vintage != null && vintage === "") {
			setVintage(String(s.vintage));
			filled.push("ヴィンテージ");
		}
		if (s.regionId && !regionId) {
			setRegionId(s.regionId);
			filled.push("地域");
		}
		if (s.aopId && !aopId && (!regionId || regionId === s.regionId)) {
			setAopId(s.aopId);
			filled.push("AOP");
		}
		if (s.grapeVarietyIds?.length && grapeVarietyIds.length === 0) {
			setGrapeVarietyIds(s.grapeVarietyIds);
			filled.push("ぶどう品種");
		}
		return filled;
	};

	const { mutate: analyzeLabel, isPending: isAnalyzing } = useMutation({
		mutationFn: async () => {
			if (photos.length === 0) throw new Error("写真を選択してください");
			// 既存写真はURL(同一オリジン)、新規はFileとして全枚数を総合解析する
			const sources: AnalysisPhotoSource[] = photos.map((p) =>
				p.kind === "new" ? p.file : { url: photoSrc(p) },
			);
			return analyzeLabelPhotos(sources);
		},
		onSuccess: (result) => {
			// クレジットを消費するのでヘッダ等の残高表示を更新する
			void queryClient.invalidateQueries({
				queryKey: CREDIT_BALANCE_QUERY_KEY,
			});
			if (result.blocked) {
				setShowInsufficient(true);
				return;
			}
			const filled = applySuggestions(result.suggestions);
			setAnalyzeNotice(
				filled.length > 0
					? `エチケットから自動入力しました: ${filled.join("、")}`
					: "エチケットから入力できる新しい項目はありませんでした(入力済みの項目は上書きしません)",
			);
		},
		onError: (e: Error) =>
			setError(e.message || "エチケットの解析に失敗しました"),
	});

	const { mutate: save, isPending } = useMutation({
		mutationFn: async () => {
			const trimmedName = name.trim();
			const vintageNum = vintage === "" ? undefined : Number(vintage);
			const priceNum = price === "" ? undefined : Number(price);

			let saved: DrunkWineEntry;
			const existing = entry ?? createdRef.current;
			if (existing) {
				// 更新: null=クリア(空欄に戻した項目もDBへ反映する)
				saved = await updateDrunkWine({
					data: {
						id: existing.id,
						name: trimmedName,
						drankOn: drankOn === "" ? null : drankOn,
						aopId: aopId ?? null,
						rating,
						memo: memo === "" ? null : memo,
						vintage: vintageNum ?? null,
						grapeVarietyIds,
						producer: producer.trim() === "" ? null : producer.trim(),
						price: priceNum ?? null,
					},
				});
			} else {
				saved = await createDrunkWine({
					data: {
						name: trimmedName,
						drankOn: drankOn === "" ? undefined : drankOn,
						aopId,
						rating: rating ?? undefined,
						memo: memo === "" ? undefined : memo,
						vintage: vintageNum,
						grapeVarietyIds:
							grapeVarietyIds.length > 0 ? grapeVarietyIds : undefined,
						producer: producer.trim() === "" ? undefined : producer.trim(),
						price: priceNum,
					},
				});
				createdRef.current = saved;
			}
			// 写真集合を同期する。新規追加も既存の削除・並べ替えもここで反映される。
			// 新規作成で写真が無い場合はスキップ(不要なリクエストを避ける)
			const hadPhotos = (entry?.photoUrls.length ?? 0) > 0;
			if (photos.length > 0 || hadPhotos) {
				saved = await syncPhotos(saved.id, photos);
			}
			return saved;
		},
		onSuccess: async (saved) => {
			for (const p of photos) {
				if (p.kind === "new") URL.revokeObjectURL(p.previewUrl);
			}
			await onSaved(saved);
		},
		onError: (err: Error) => setError(err.message),
	});

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(e) => {
				e.preventDefault();
				setError("");
				save();
			}}
		>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="wine-name">
					名前 <span className="text-destructive">*</span>
				</Label>
				<Input
					id="wine-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="例: シャブリ プルミエ・クリュ"
					maxLength={200}
					required
				/>
			</div>

			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-drank-on">飲んだ日</Label>
					<Input
						id="wine-drank-on"
						type="date"
						value={drankOn}
						onChange={(e) => setDrankOn(e.target.value)}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label>評価</Label>
					<div className="flex h-9 items-center gap-0.5">
						{[1, 2, 3, 4, 5].map((n) => {
							const active = rating !== null && n <= rating;
							return (
								<button
									key={n}
									type="button"
									aria-label={`星${n}`}
									aria-pressed={rating === n}
									onClick={() => setRating(rating === n ? null : n)}
									className="rounded-sm p-1 transition-transform hover:scale-110 focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
								>
									<StarIcon
										className={cn(
											"size-6",
											active
												? "fill-amber-400 text-amber-400"
												: "text-muted-foreground/40",
										)}
										aria-hidden
									/>
								</button>
							);
						})}
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-vintage">ヴィンテージ</Label>
					<Input
						id="wine-vintage"
						type="number"
						min={1800}
						max={2100}
						value={vintage}
						onChange={(e) => setVintage(e.target.value)}
						placeholder="例: 2020"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-producer">生産者</Label>
					<Input
						id="wine-producer"
						type="text"
						value={producer}
						onChange={(e) => setProducer(e.target.value)}
						placeholder="例: ドメーヌ・ルフレーヴ"
						maxLength={200}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-price">価格(円)</Label>
					<Input
						id="wine-price"
						type="number"
						min={0}
						max={10_000_000}
						value={price}
						onChange={(e) => setPrice(e.target.value)}
						placeholder="例: 5000"
					/>
				</div>
			</div>

			<fieldset className="flex flex-col gap-3">
				<Label asChild>
					<legend>AOP紐付け(任意)</legend>
				</Label>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<Select
						value={regionId ?? REGION_NONE}
						onValueChange={(v) => {
							const next = v === REGION_NONE ? undefined : v;
							setRegionId(next);
							// 地域を変えたら別地域のAOPが残らないようクリアする
							if (aopId && getAop(aopId)?.region !== next) {
								setAopId(undefined);
							}
						}}
					>
						<SelectTrigger aria-label="地域を選択">
							<SelectValue placeholder="地域を選択" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={REGION_NONE}>紐付けない</SelectItem>
							{regions.map((r) => (
								<SelectItem key={r.id} value={r.id}>
									{r.nameJa}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					{regionId && (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => setAopPickerOpen(true)}
								className="justify-between font-normal"
							>
								<span className={cn(!selectedAop && "text-muted-foreground")}>
									{selectedAop ? selectedAop.nameJa : "AOPを選択"}
								</span>
								<ChevronsUpDownIcon className="size-4 opacity-50" aria-hidden />
							</Button>
							<CommandDialog
								open={aopPickerOpen}
								onOpenChange={setAopPickerOpen}
								title="AOPを選択"
								description="AOPを検索して選択します。"
							>
								<CommandInput placeholder="AOPを検索(日本語・現地語)…" />
								<CommandList>
									<CommandEmpty>該当するAOPがありません。</CommandEmpty>
									<CommandGroup>
										<CommandItem
											value={REGION_NONE}
											keywords={["紐付けない", "クリア", "none"]}
											onSelect={() => {
												setAopId(undefined);
												setAopPickerOpen(false);
											}}
										>
											<CheckIcon
												className={cn(
													"size-4",
													aopId === undefined ? "opacity-100" : "opacity-0",
												)}
												aria-hidden
											/>
											紐付けない
										</CommandItem>
										{aopCandidates.map((aop) => (
											<CommandItem
												key={aop.id}
												value={aop.id}
												keywords={[aop.nameJa, aop.shortName]}
												onSelect={() => {
													setAopId(aop.id);
													setAopPickerOpen(false);
												}}
											>
												<CheckIcon
													className={cn(
														"size-4",
														aop.id === aopId ? "opacity-100" : "opacity-0",
													)}
													aria-hidden
												/>
												<span>{aop.nameJa}</span>
												<span className="text-xs text-muted-foreground">
													{aop.shortName}
												</span>
											</CommandItem>
										))}
									</CommandGroup>
								</CommandList>
							</CommandDialog>
						</>
					)}
				</div>
			</fieldset>

			<fieldset className="flex flex-col gap-3">
				<Label asChild>
					<legend>ぶどう品種(複数選択可)</legend>
				</Label>
				{[
					{ label: "黒ブドウ", varieties: redVarieties },
					{ label: "白ブドウ", varieties: whiteVarieties },
				].map((group) => (
					<div key={group.label} className="flex flex-col gap-2">
						<p className="text-xs font-medium text-muted-foreground">
							{group.label}
						</p>
						<div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
							{group.varieties.map((v) => (
								<div key={v.id} className="flex items-center gap-2">
									<Checkbox
										id={`grape-${v.id}`}
										checked={grapeVarietyIds.includes(v.id)}
										onCheckedChange={() => toggleVariety(v.id)}
									/>
									<Label
										htmlFor={`grape-${v.id}`}
										className="text-sm font-normal"
									>
										{v.nameJa}
									</Label>
								</div>
							))}
						</div>
					</div>
				))}
			</fieldset>

			<div className="flex flex-col gap-3">
				<Label htmlFor="wine-photo">写真</Label>

				{photos.length > 0 && (
					<ul className="flex flex-wrap gap-3">
						{photos.map((p, index) => (
							<li
								key={p.localId}
								className="relative h-24 w-24 overflow-hidden rounded-md border border-border"
							>
								<img
									src={photoSrc(p)}
									alt={index === 0 ? "代表写真" : `写真${index + 1}`}
									className="h-full w-full object-cover"
								/>
								{index === 0 && (
									<span className="absolute left-1 top-1 rounded bg-foreground/80 px-1 py-0.5 text-[10px] font-medium leading-none text-background">
										代表
									</span>
								)}
								<button
									type="button"
									aria-label={`写真${index + 1}を削除`}
									onClick={() => removePhoto(p.localId)}
									className="absolute right-1 top-1 rounded-full bg-foreground/70 p-0.5 text-background transition-colors hover:bg-foreground"
								>
									<XIcon className="size-3.5" aria-hidden />
								</button>
								<div className="absolute inset-x-1 bottom-1 flex justify-between">
									<button
										type="button"
										aria-label={`写真${index + 1}を前へ`}
										disabled={index === 0}
										onClick={() => movePhoto(p.localId, -1)}
										className="rounded bg-background/80 p-0.5 text-foreground transition-opacity hover:bg-background disabled:opacity-30"
									>
										<ArrowLeftIcon className="size-3.5" aria-hidden />
									</button>
									<button
										type="button"
										aria-label={`写真${index + 1}を後ろへ`}
										disabled={index === photos.length - 1}
										onClick={() => movePhoto(p.localId, 1)}
										className="rounded bg-background/80 p-0.5 text-foreground transition-opacity hover:bg-background disabled:opacity-30"
									>
										<ArrowRightIcon className="size-3.5" aria-hidden />
									</button>
								</div>
							</li>
						))}
					</ul>
				)}

				<div className="flex flex-col gap-2">
					<Input
						id="wine-photo"
						ref={fileInputRef}
						type="file"
						accept={PHOTO_ACCEPT_ATTR}
						multiple
						onChange={handleFileChange}
						disabled={photos.length >= MAX_PHOTOS_PER_ENTRY}
						className="max-w-xs"
					/>
					<p className="text-xs text-muted-foreground">
						JPEG・PNG・WebP・GIF、各5MBまで。最大{MAX_PHOTOS_PER_ENTRY}
						枚(1枚目が代表・矢印で並べ替え)
					</p>
					{photos.length > 0 && (
						<div className="flex flex-col gap-1">
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="self-start"
								disabled={isAnalyzing}
								onClick={() => {
									setError("");
									setAnalyzeNotice("");
									analyzeLabel();
								}}
							>
								<SparklesIcon className="size-4" aria-hidden />
								{isAnalyzing ? "解析中..." : "エチケットから自動入力"}
							</Button>
							<p className="text-xs text-muted-foreground">
								AIが全ての写真を総合して読み取り、未入力の項目を自動で埋めます(AIクレジットを消費)
							</p>
						</div>
					)}
					{analyzeNotice && (
						<p className="text-xs text-muted-foreground">{analyzeNotice}</p>
					)}
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="wine-memo">メモ</Label>
				<Textarea
					id="wine-memo"
					value={memo}
					onChange={(e) => setMemo(e.target.value)}
					placeholder="味わいの感想、合わせた料理など"
					maxLength={2000}
					rows={4}
				/>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<Button
				type="submit"
				disabled={isPending || !name.trim()}
				className="self-start"
			>
				{isPending ? "保存中..." : entry ? "更新する" : "記録する"}
			</Button>

			<InsufficientCreditsDialog
				open={showInsufficient}
				onOpenChange={setShowInsufficient}
			/>
		</form>
	);
}
