import { useMutation } from "@tanstack/react-query";
import { CheckIcon, ChevronsUpDownIcon, StarIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES } from "#/lib/drunk-wine/photo";
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

async function uploadPhoto(
	entryId: string,
	file: File,
): Promise<DrunkWineEntry> {
	const form = new FormData();
	form.append("photo", file);
	form.append("entryId", entryId);
	const res = await fetch("/api/wine-photos", { method: "POST", body: form });
	const body = (await res.json()) as { error?: string; entry?: DrunkWineEntry };
	if (!res.ok || !body.entry) {
		throw new Error(body.error ?? "写真のアップロードに失敗しました");
	}
	return body.entry;
}

// 追加/編集共用のフォーム。作成と更新でserver fnのnull/undefined規約が
// 異なる(更新は null=クリア)ため、送信ペイロードだけ分岐する。
// 写真はエントリ確定後でないとR2キー(entryId依存)が決まらないので、
// server fn成功後に /api/wine-photos へ別途POSTする。
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
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [error, setError] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);
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

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		if (!file) return;
		// サーバ側の 400 を待たずに弾く(制約は photo.ts と共通)
		if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
			setError("対応していない画像形式です(JPEG/PNG/WebP/GIF)");
			return;
		}
		if (file.size > MAX_PHOTO_BYTES) {
			setError("写真は5MB以下にしてください");
			return;
		}
		setError("");
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		setSelectedFile(file);
		setPreviewUrl(URL.createObjectURL(file));
	};

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
			if (selectedFile) {
				saved = await uploadPhoto(saved.id, selectedFile);
			}
			return saved;
		},
		onSuccess: async (saved) => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			await onSaved(saved);
		},
		onError: (err: Error) => setError(err.message),
	});

	// 差し替え時にR2キーが変わらない(同一MIME)場合があるので、updatedAtで
	// ブラウザキャッシュをバストする
	const savedPhotoUrl = entry?.photoUrl
		? `${entry.photoUrl}?v=${entry.updatedAt}`
		: null;
	const currentPhotoUrl = previewUrl ?? savedPhotoUrl;

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
				<div className="flex items-start gap-4">
					{currentPhotoUrl && (
						<img
							src={currentPhotoUrl}
							alt="ワイン写真プレビュー"
							className="h-24 w-24 rounded-md border border-border object-cover"
						/>
					)}
					<div className="flex flex-col gap-2">
						<Input
							id="wine-photo"
							ref={fileInputRef}
							type="file"
							accept="image/jpeg,image/png,image/webp,image/gif"
							onChange={handleFileChange}
							className="max-w-xs"
						/>
						<p className="text-xs text-muted-foreground">
							JPEG・PNG・WebP・GIF、最大5MB
						</p>
					</div>
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
		</form>
	);
}
