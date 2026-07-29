import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { DrunkWineFields } from "#/components/cellar/DrunkWineFields";
import {
	buildCreateInput,
	buildTastingInput,
	buildUpdatePatch,
	type DrunkWineFieldsValue,
	EMPTY_TASTING_DRAFT,
	fieldsValueFromEntry,
	hasUnsavedDrunkWineChanges,
	toFormState,
	type WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import {
	type AnalysisPhotoSource,
	analyzeLabelPhotos,
} from "#/components/cellar/label-analysis";
import { downscaleImage } from "#/components/cellar/photo-resize";
import { TastingFields } from "#/components/cellar/TastingFields";
import { UnsavedChangesGuard } from "#/components/cellar/UnsavedChangesGuard";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { LiveRegion } from "#/components/ui/live-region";
import { TAP_TARGET_44 } from "#/lib/a11y";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import { CREDIT_BALANCE_QUERY_KEY } from "#/lib/credit/use-credit";
import { hasDrunkWinePatch } from "#/lib/drunk-wine/fields";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
	PHOTO_ACCEPT_ATTR,
	PHOTO_FORMATS_LABEL_JA,
	PHOTO_THUMB_JPEG_QUALITY,
	PHOTO_THUMB_MAX_DIMENSION,
	thumbKeyForPhotoKey,
} from "#/lib/drunk-wine/photo";
import { imageKeyFromPath, imagePathForKey } from "#/lib/images/signed-url";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { cn } from "#/lib/utils";
import { createDrunkWine, updateDrunkWine } from "#/server/drunk-wine";

export interface DrunkWineFormProps {
	/** 既存エントリ(編集時)。未指定なら新規作成 */
	entry?: DrunkWineEntry;
	/** 保存(写真アップロードを含む)が完了したエントリを受け取る */
	onSaved: (entry: DrunkWineEntry) => void | Promise<void>;
	/**
	 * 編集時の飲用記録セクション(TastingList)。新規作成時は記録がまだ無いので
	 * 未指定にし、フォーム内の TastingFields で1件ぶんを同時入力する。
	 */
	tastingSlot?: React.ReactNode;
}

// フォームが扱う写真1枚。既存はR2キー保持、新規はローカルFile+プレビューURL。
// localId はReactのkeyと並べ替え・削除の同定に使う(表示順は配列順)。
type PhotoItem =
	| { localId: string; kind: "existing"; key: string }
	| { localId: string; kind: "new"; file: File; previewUrl: string };

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
			// 一覧用サムネイルをブラウザ側で作って一緒に送る(#237)。生成に失敗しても
			// 送らないだけで保存は続行できる(配信側が原寸へフォールバックする)。
			const thumb = await downscaleImage(p.file, {
				maxDimension: PHOTO_THUMB_MAX_DIMENSION,
				quality: PHOTO_THUMB_JPEG_QUALITY,
				forceReencode: true,
			});
			form.append("thumb", thumb, `thumb-${i}.jpg`);
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

// 追加/編集共用のフォーム。送信ペイロードの規約(空欄→null / 全解除→[] /
// name はクリア不可 / 未変更は送らない)は src/lib/drunk-wine/fields.ts が単一情報源で、
// フォーム state との橋渡しは drunk-wine-payload.ts に切り出してある。更新は差分パッチ。
// 写真は複数枚。エントリ確定後でないとR2キー(entryId依存)が決まらないので、
// server fn成功後に /api/wine-photos へ写真集合を同期POSTする(追加・削除・並べ替えを一括反映)。
export function DrunkWineForm({
	entry,
	onSaved,
	tastingSlot,
}: DrunkWineFormProps) {
	// 入力項目の state は MCP App のフォームと共有する形(DrunkWineFieldsValue)で持つ
	const [values, setValues] = useState<DrunkWineFieldsValue>(() =>
		fieldsValueFromEntry(entry),
	);
	const update = (patch: Partial<DrunkWineFieldsValue>) =>
		setValues((prev) => ({ ...prev, ...patch }));
	// 新規作成時にだけ使う「最初の1件」の飲用記録。編集時は tastingSlot(TastingList)
	// が担当するので触らない。
	const [tastingDraft, setTastingDraft] =
		useState<WineTastingDraft>(EMPTY_TASTING_DRAFT);
	// 写真は複数枚。表示順=配列順、先頭が代表(サムネイル)。既存写真はキーで保持する
	const [photos, setPhotos] = useState<PhotoItem[]>(() =>
		(entry?.photoUrls ?? []).map((url, i) => ({
			localId: `e${i}`,
			kind: "existing" as const,
			key: imageKeyFromPath(url),
		})),
	);
	const [error, setError] = useState("");
	const [analyzeNotice, setAnalyzeNotice] = useState("");
	const [showInsufficient, setShowInsufficient] = useState(false);
	const queryClient = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	// 新規写真の localId 採番用(既存は e{i}、新規は n{連番})
	const newIdRef = useRef(0);
	// 直近にサーバで確定したエントリ。2つの役割がある:
	//  - 新規作成でエントリ作成後に写真アップロードだけ失敗した場合、再送信で
	//    重複エントリを作らないよう更新に切り替える
	//  - 更新の差分パッチの基準。entry propは初期表示時のスナップショットなので、
	//    保存成功後の再送信ではこちらを優先しないと「一度保存した値に戻す」変更が
	//    差分ゼロと判定されて反映されない
	const savedRef = useRef<DrunkWineEntry | null>(null);
	// 保存が完了して呼び出し側が遷移する間だけ離脱ガードを黙らせる。state ではなく ref
	// なのは、保存成功と遷移が同じ tick で起きるため(再レンダリングが間に合わない)。
	const leavingAfterSaveRef = useRef(false);

	// 未保存の変更の有無。初期値(=直近に保存した内容)と現在値を比べる。
	// 判定ロジックは drunk-wine-payload.ts が単一情報源(#238)。
	const baseline = savedRef.current ?? entry;
	const isDirty = () =>
		hasUnsavedDrunkWineChanges({
			initial: fieldsValueFromEntry(baseline),
			values,
			tasting: tastingDraft,
			initialPhotoKeys: (baseline?.photoUrls ?? []).map(imageKeyFromPath),
			photoKeys: photos.map((p) => (p.kind === "existing" ? p.key : null)),
		});

	// 既存写真の表示URL(キャッシュバスタ付き)。解析時のfetchにも使う
	const photoSrc = (p: PhotoItem): string =>
		p.kind === "new"
			? p.previewUrl
			: `${imagePathForKey(p.key)}?v=${entry?.updatedAt ?? ""}`;

	// 一覧と同じく、表示用には縮小版を読む(#237)。実体が無ければ配信側が原寸を返す。
	const photoThumbSrc = (p: PhotoItem): string =>
		p.kind === "new"
			? p.previewUrl
			: `${imagePathForKey(thumbKeyForPhotoKey(p.key))}?v=${entry?.updatedAt ?? ""}`;

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
				rejectMsg = `対応していない画像形式です(${PHOTO_FORMATS_LABEL_JA})`;
				continue;
			}
			if (file.size > MAX_PHOTO_BYTES) {
				rejectMsg = `写真は${MAX_PHOTO_SIZE_LABEL}以下にしてください`;
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
		const patch: Partial<DrunkWineFieldsValue> = {};
		if (s.name && !values.name.trim()) {
			patch.name = s.name;
			filled.push("名前");
		}
		if (s.producer && !values.producer.trim()) {
			patch.producer = s.producer;
			filled.push("生産者");
		}
		if (s.vintage != null && values.vintage === "") {
			patch.vintage = String(s.vintage);
			filled.push("ヴィンテージ");
		}
		if (s.regionId && !values.regionId) {
			patch.regionId = s.regionId;
			filled.push("地域");
		}
		if (
			s.aopId &&
			!values.aopId &&
			(!values.regionId || values.regionId === s.regionId)
		) {
			patch.aopId = s.aopId;
			filled.push("AOP");
		}
		if (s.grapeVarietyIds?.length && values.grapeVarietyIds.length === 0) {
			patch.grapeVarietyIds = s.grapeVarietyIds;
			filled.push("ぶどう品種");
		}
		if (filled.length > 0) update(patch);
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
			const state = toFormState(values);

			let saved: DrunkWineEntry;
			const existing = savedRef.current ?? entry;
			if (existing) {
				// 更新: 変更したフィールドだけを送る(null=クリア)。
				// 全キー未指定のパッチは空UPDATEになるので送信自体をスキップする
				const patch = buildUpdatePatch(existing, state);
				saved = hasDrunkWinePatch(patch)
					? await updateDrunkWine({ data: { id: existing.id, ...patch } })
					: existing;
			} else {
				// 新規作成は銘柄と飲用記録を1リクエストで作る(サービス層が db.batch で
				// 原子化する)。写真だけは R2 キーが entryId 依存なので2段階のまま。
				saved = await createDrunkWine({
					data: buildCreateInput(state, buildTastingInput(tastingDraft)),
				});
			}
			savedRef.current = saved;
			// 写真集合を同期する。新規追加も既存の削除・並べ替えもここで反映される。
			// 新規作成で写真が無い場合はスキップ(不要なリクエストを避ける)
			const hadPhotos = (entry?.photoUrls.length ?? 0) > 0;
			if (photos.length > 0 || hadPhotos) {
				saved = await syncPhotos(saved.id, photos);
				savedRef.current = saved;
			}
			return saved;
		},
		onSuccess: async (saved) => {
			for (const p of photos) {
				if (p.kind === "new") URL.revokeObjectURL(p.previewUrl);
			}
			// 保存済みなので、この後の遷移は警告しない(onSaved が遷移することが多い)
			leavingAfterSaveRef.current = true;
			await onSaved(saved);
		},
		onError: (err: Error) => setError(err.message),
	});

	// 写真UIはWeb版だけの機能(追加・削除・並べ替えは認証必須の /api/wine-photos を
	// 叩く)。共有の入力項目には slot として差し込む。
	const photoSection = (
		<div className="flex flex-col gap-3">
			<Label htmlFor="wine-photo">写真</Label>

			{photos.length > 0 && (
				<ul className="flex flex-wrap gap-3">
					{photos.map((p, index) => (
						<li
							key={p.localId}
							className="relative h-24 w-24 rounded-md border border-border"
						>
							<img
								src={photoThumbSrc(p)}
								alt={index === 0 ? "代表写真" : `写真${index + 1}`}
								className="h-full w-full rounded-md object-cover"
								loading="lazy"
								decoding="async"
								width={96}
								height={96}
							/>
							{index === 0 && (
								<span className="absolute left-1 top-1 rounded bg-foreground/80 px-1 py-0.5 text-[10px] font-medium leading-none text-background">
									代表
								</span>
							)}
							{/*
							  当たり判定は TAP_TARGET_44 で44px確保する(#239)。削除は確認なしで
							  即実行されるため、並べ替えとは対角(右上 / 左下・右下)に置いて
							  中心を64px離し、44pxの判定が重ならないようにしている。
							*/}
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
							<div className="absolute inset-x-1 bottom-1 flex justify-between">
								<button
									type="button"
									aria-label={`写真${index + 1}を前へ`}
									disabled={index === 0}
									onClick={() => movePhoto(p.localId, -1)}
									className={cn(
										"relative rounded bg-background/80 p-1 text-foreground transition-opacity hover:bg-background disabled:opacity-30",
										TAP_TARGET_44,
									)}
								>
									<ArrowLeftIcon className="size-4" aria-hidden />
								</button>
								<button
									type="button"
									aria-label={`写真${index + 1}を後ろへ`}
									disabled={index === photos.length - 1}
									onClick={() => movePhoto(p.localId, 1)}
									className={cn(
										"relative rounded bg-background/80 p-1 text-foreground transition-opacity hover:bg-background disabled:opacity-30",
										TAP_TARGET_44,
									)}
								>
									<ArrowRightIcon className="size-4" aria-hidden />
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
					{PHOTO_FORMATS_LABEL_JA}、各{MAX_PHOTO_SIZE_LABEL}まで。最大
					{MAX_PHOTOS_PER_ENTRY}
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
	);

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(e) => {
				e.preventDefault();
				setError("");
				save();
			}}
		>
			<DrunkWineFields
				value={values}
				onChange={update}
				photoSlot={photoSection}
				tastingSlot={
					tastingSlot ?? (
						<fieldset className="flex flex-col gap-4">
							<Label asChild>
								<legend>飲んだ記録(任意)</legend>
							</Label>
							<p className="-mt-2 text-xs text-muted-foreground">
								飲んだ日や感想を入れると、飲用記録として保存されます。まだ飲んでいない場合は空のままで構いません。
							</p>
							<TastingFields
								value={tastingDraft}
								onChange={(patch) =>
									setTastingDraft((d) => ({ ...d, ...patch }))
								}
								idPrefix="wine-tasting"
							/>
						</fieldset>
					)
				}
			/>

			{/* 送信失敗は対処が要るので assertive。空でもコンテナを残さないと読み上げられない(#239) */}
			<LiveRegion tone="alert" className="empty:-mt-6">
				{error && <p className="text-sm text-destructive">{error}</p>}
			</LiveRegion>

			<Button
				type="submit"
				disabled={isPending || !values.name.trim()}
				className="self-start"
			>
				{isPending ? "保存中..." : entry ? "更新する" : "記録する"}
			</Button>

			<InsufficientCreditsDialog
				open={showInsufficient}
				onOpenChange={setShowInsufficient}
			/>

			{/* 未保存のまま離脱しようとしたら警告する(保存直後の遷移は除く) */}
			<UnsavedChangesGuard
				shouldBlock={() => !leavingAfterSaveRef.current && isDirty()}
			/>
		</form>
	);
}
