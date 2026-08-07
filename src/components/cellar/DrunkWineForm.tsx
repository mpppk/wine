import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { LabelSuggestionDiffDialog } from "#/components/cellar/LabelSuggestionDiffDialog";
import {
	type AnalysisPhotoSource,
	analyzeLabelPhotos,
	submitLabelAnalysisJob,
} from "#/components/cellar/label-analysis";
import {
	buildLabelDiffs,
	type LabelDiffItem,
} from "#/components/cellar/label-suggestion-diff";
import { downscaleImage } from "#/components/cellar/photo-resize";
import { TastingFields } from "#/components/cellar/TastingFields";
import { UnsavedChangesGuard } from "#/components/cellar/UnsavedChangesGuard";
import {
	LABEL_JOB_BADGE_QUERY_KEY,
	useLabelAnalysisJob,
} from "#/components/cellar/use-label-analysis-job";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import { FormField, FormSection } from "#/components/ui/form-section";
import { Input } from "#/components/ui/input";
import { LiveRegion } from "#/components/ui/live-region";
import { TAP_TARGET_44 } from "#/lib/a11y";
import { estimateLabelReserveCharge } from "#/lib/ai/config";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import { costToCredits } from "#/lib/credit/credit-math";
import {
	CREDIT_BALANCE_QUERY_KEY,
	useCreditBalanceValue,
} from "#/lib/credit/use-credit";
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
import { postImageForm } from "#/lib/images/form-client";
import { imageKeyFromPath, imagePathForKey } from "#/lib/images/signed-url";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { cn } from "#/lib/utils";
import { getLabelAnalysisPlan } from "#/server/ai";
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
	/**
	 * 新規作成時の初期値(一括登録からの引き継ぎ #416)。`entry` 指定時は無視する。
	 * 初期値が入っていると離脱ガードの基準(未保存の変更あり)にもなる——引き継いだ
	 * 内容はクレジットを消費して得たものなので、黙って捨てさせない。
	 */
	initialValues?: DrunkWineFieldsValue;
	/** 新規作成時にフォームへ添付済みにする写真。`entry` 指定時は無視する。 */
	initialPhotoFiles?: File[];
	/**
	 * マウント直後にエチケット解析を1回だけ自動実行する(#416)。結果は差分ダイアログを
	 * 挟まずそのまま反映する——ユーザは遷移前の確認ダイアログで既に「解析して記録する」
	 * を選んでおり、ここでもう一度選ばせるのは同じ意思決定の二度手間になるため。
	 */
	autoAnalyzeLabel?: boolean;
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
	const fallbackMessage = "写真のアップロードに失敗しました";
	const body = await postImageForm<{ entry?: DrunkWineEntry }>(
		"/api/wine-photos",
		form,
		{ fallbackMessage },
	);
	if (!body.entry) throw new Error(fallbackMessage);
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
	initialValues,
	initialPhotoFiles,
	autoAnalyzeLabel,
}: DrunkWineFormProps) {
	// 入力項目の state は MCP App のフォームと共有する形(DrunkWineFieldsValue)で持つ
	const [values, setValues] = useState<DrunkWineFieldsValue>(
		() => (entry ? undefined : initialValues) ?? fieldsValueFromEntry(entry),
	);
	const update = (patch: Partial<DrunkWineFieldsValue>) =>
		setValues((prev) => ({ ...prev, ...patch }));
	// 新規作成時にだけ使う「最初の1件」の飲用記録。編集時は tastingSlot(TastingList)
	// が担当するので触らない。
	const [tastingDraft, setTastingDraft] =
		useState<WineTastingDraft>(EMPTY_TASTING_DRAFT);
	// 写真は複数枚。表示順=配列順、先頭が代表(サムネイル)。既存写真はキーで保持する
	const [photos, setPhotos] = useState<PhotoItem[]>(() => {
		if (entry) {
			return entry.photoUrls.map((url, i) => ({
				localId: `e${i}`,
				kind: "existing" as const,
				key: imageKeyFromPath(url),
			}));
		}
		// 引き継いだ写真(#416)。枚数の上限は呼び出し側で切り詰め済み
		return (initialPhotoFiles ?? []).map((file, i) => ({
			localId: `h${i}`,
			kind: "new" as const,
			file,
			previewUrl: URL.createObjectURL(file),
		}));
	});
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

	// エチケット解析の候補と現在値の差分。ダイアログで選ばせている間だけ値を持つ。
	//
	// 「未入力の項目だけに自動反映する」形(#374 までの applySuggestions)はここで
	// 廃止した。産地の排他(最も細かい1つだけ)を含む適用ルールは buildLabelDiffs が
	// 一手に持ち、反映するかどうかはユーザが選ぶ(#362)。
	const [labelDiffs, setLabelDiffs] = useState<LabelDiffItem[]>([]);

	// 解析前に「この写真枚数でいくら要るか」を出す。コスト基準の計上では経路によって
	// 消費が 3 / 39 / 275 クレジットと2桁変わるので、押してから残高不足で弾かれると
	// 「なぜ足りないのか」がユーザに分からない(#355)。経路はシークレットの設定状況に
	// 依存しクライアントでは決められないため、サーバから取る。
	const { data: labelPlan } = useQuery({
		queryKey: ["label-analysis-plan"],
		queryFn: () => getLabelAnalysisPlan(),
		staleTime: 5 * 60 * 1000,
	});
	// 経路が分かるまでは金額を出さない(取得中に誤った数字を見せない)
	const requiredCredits = labelPlan
		? costToCredits(
				estimateLabelReserveCharge(labelPlan.route, photos.length).microUsd,
			)
		: null;
	// null = 未ログイン・取得中・取得失敗。残高0と区別できないので不足判定には使わない
	const balance = useCreditBalanceValue();
	const insufficientCredits =
		balance !== null && requiredCredits !== null && balance < requiredCredits;

	// ダイアログで選ばれた項目(自動実行では全項目)をマージして反映する
	const applySelectedLabelDiffs = (selected: LabelDiffItem[]) => {
		const patch = selected.reduce<Partial<DrunkWineFieldsValue>>(
			(acc, d) => Object.assign(acc, d.patch),
			{},
		);
		update(patch);
		setLabelDiffs([]);
		setAnalyzeNotice(
			selected.length > 0
				? `エチケットから入力しました: ${selected.map((d) => d.label).join("、")}`
				: "",
		);
	};

	/**
	 * 解析結果(候補)をフォームに反映する。**同期経路とジョブ経路で共有する**——
	 * 差分の作り方と提示の仕方を経路ごとに書くと、片方だけ産地の排他規則を落とすような
	 * ドリフトが起きる(#362 でその適用ルールを buildLabelDiffs に寄せたのと同じ理由)。
	 *
	 * `auto` は「遷移直後の自動実行」(#416)。ユーザ操作を起点にしないので、ダイアログを
	 * 挟まずそのまま反映する——遷移前の確認ダイアログで既に「解析して記録する」を選んで
	 * おり、ここでもう一度選ばせるのは同じ意思決定の二度手間になる。
	 */
	const applyLabelSuggestions = (
		suggestions: LabelSuggestions,
		{ auto }: { auto: boolean },
	) => {
		// 「未入力の項目にしか反映しない」自動適用だと、写真追加やエンジン切替での
		// 再解析結果が一切伝わらずクレジットだけ消費される(#362)。差分がある項目を
		// ダイアログで提示し、反映するかどうかをユーザに選ばせる。
		const diffs = buildLabelDiffs(values, suggestions);
		if (diffs.length === 0) {
			setAnalyzeNotice(
				auto
					? "エチケットを解析しました(写真から読み取った内容と差はありませんでした)"
					: "今回の解析結果と現在の入力に差分はありませんでした(クレジットは消費されています)",
			);
			return;
		}
		if (auto) {
			applySelectedLabelDiffs(diffs);
			return;
		}
		setLabelDiffs(diffs);
	};

	/** 添付中の写真を解析ソースへ。既存写真はURL(同一オリジン)、新規はFile。 */
	const analysisSources = (): AnalysisPhotoSource[] =>
		photos.map((p) => (p.kind === "new" ? p.file : { url: photoSrc(p) }));

	// 引き継ぎ直後の自動解析だけが使う**同期**経路(#462)。ここをジョブにすると、
	// 一括解析から遷移してきた画面が空のまま出てしまう(結果が入っていることが体験の要)。
	const { mutate: analyzeLabelSync, isPending: isAnalyzingSync } = useMutation({
		mutationFn: async () => {
			if (photos.length === 0) throw new Error("写真を選択してください");
			return analyzeLabelPhotos(analysisSources());
		},
		onSuccess: (result) => {
			// クレジットを消費するのでヘッダ等の残高表示を更新する
			void queryClient.invalidateQueries({
				queryKey: CREDIT_BALANCE_QUERY_KEY,
			});
			if (result.blocked) {
				// 自動実行では残高不足のモーダルを出さない。ユーザが押していない処理で
				// 画面到達直後にモーダルが被さると、引き継いだ入力内容(=一括解析で
				// 既にクレジットを払って得たもの)が見えないまま驚かせるだけになる。
				setAnalyzeNotice(
					"クレジットが不足しているため、詳細なエチケット解析は実行できませんでした。写真から読み取った内容をそのまま入力しています。",
				);
				return;
			}
			applyLabelSuggestions(result.suggestions, { auto: true });
		},
		onError: (e: Error) =>
			setError(e.message || "エチケットの解析に失敗しました"),
	});

	// ---- ジョブ経路(利用者が押すボタン。#462) ----
	//
	// 投入が返った時点でサーバに予約と写真が載っているので、**ここから先はページを
	// 離れてよい**。フォームに留まっていればポーリングが完了を拾い、従来と同じ差分
	// ダイアログが出る。離脱した場合はマイセラーのバッジから受け取れる。
	const [jobId, setJobId] = useState<string | null>(null);
	const { data: job } = useLabelAnalysisJob(jobId);
	// 完了を1回だけ処理する。ポーリングは終端で止まるが、その最後の1件が
	// 再レンダリングのたびに流れ込まないようにする。
	const handledJobRef = useRef<string | null>(null);

	const { mutate: startAnalysisJob, isPending: isSubmittingJob } = useMutation({
		mutationFn: async () => {
			if (photos.length === 0) throw new Error("写真を選択してください");
			return submitLabelAnalysisJob(analysisSources());
		},
		onSuccess: (result) => {
			// 投入時点で予約が立つ(=残高が動く)ので、ここで残高表示を更新する。
			void queryClient.invalidateQueries({
				queryKey: CREDIT_BALANCE_QUERY_KEY,
			});
			void queryClient.invalidateQueries({
				queryKey: LABEL_JOB_BADGE_QUERY_KEY,
			});
			if (result.blocked) {
				setShowInsufficient(true);
				return;
			}
			setJobId(result.jobId);
			setAnalyzeNotice(
				"解析を開始しました。完了までこのページを離れても構いません(マイセラーから結果を受け取れます)。",
			);
		},
		onError: (e: Error) => setError(e.message || "解析の受付に失敗しました"),
	});

	// applyLabelSuggestions は values を読むが、**完了時点の入力**に対して差分を出すのが
	// 正しい(解析中に編集した内容を上書き候補として見せる)。依存に values を入れると
	// 入力のたびに再実行されるため、意図的に job の遷移だけを見る。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 完了の1回だけ処理する
	useEffect(() => {
		if (!job || handledJobRef.current === job.jobId) return;
		if (job.status === "queued" || job.status === "running") return;
		handledJobRef.current = job.jobId;
		// 実測での確定が済んでいるので残高を引き直す(予約時との差分が戻っている)。
		void queryClient.invalidateQueries({ queryKey: CREDIT_BALANCE_QUERY_KEY });
		void queryClient.invalidateQueries({ queryKey: LABEL_JOB_BADGE_QUERY_KEY });
		if (job.status === "failed" || !job.suggestions) {
			setError(job.error || "エチケットの解析に失敗しました");
			setAnalyzeNotice("");
			return;
		}
		setAnalyzeNotice("");
		applyLabelSuggestions(job.suggestions, { auto: false });
	}, [job, queryClient]);

	// 引き継ぎ直後の自動解析は1回だけ。写真が無ければ何もしない(解析対象が無い)。
	const autoAnalyzedRef = useRef(false);
	useEffect(() => {
		if (!autoAnalyzeLabel || autoAnalyzedRef.current) return;
		if (photos.length === 0) return;
		autoAnalyzedRef.current = true;
		setAnalyzeNotice("エチケットを解析しています…");
		analyzeLabelSync();
	}, [autoAnalyzeLabel, photos.length, analyzeLabelSync]);

	/** 解析中(投入待ち + ジョブ実行中 + 引き継ぎ直後の同期解析)。 */
	const isAnalyzing =
		isSubmittingJob ||
		isAnalyzingSync ||
		(job !== undefined &&
			(job.status === "queued" || job.status === "running"));

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
		<FormField label="写真" htmlFor="wine-photo">
			{/* 見出し直下は説明ではなく中身が続くので、要素同士の間隔だけここで持つ */}
			<div className="flex flex-col gap-3">
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
									startAnalysisJob();
								}}
							>
								<SparklesIcon className="size-4" aria-hidden />
								{isAnalyzing ? "解析中..." : "エチケットから自動入力"}
							</Button>
							<p className="text-xs text-muted-foreground">
								AIが全ての写真を総合して読み取り、現在の入力と違う項目を反映するか選べます
								{requiredCredits === null
									? "(AIクレジットを消費)"
									: `(約${requiredCredits.toLocaleString("ja-JP")}クレジットを消費)`}
								。解析はサーバ側で続くので、待たずにページを離れても構いません
							</p>
							{insufficientCredits && (
								<p className="text-xs text-destructive">
									クレジットが不足しています(残高
									{balance?.toLocaleString("ja-JP")}
									)。プロフィールで解析エンジンを 「標準(Workers
									AI)」に変えると消費を抑えられます。
								</p>
							)}
						</div>
					)}
					{analyzeNotice && (
						<p className="text-xs text-muted-foreground">{analyzeNotice}</p>
					)}
				</div>
			</div>
		</FormField>
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
						<FormSection
							title="飲んだ記録(任意)"
							description="飲んだ日や感想を入れると、飲用記録として保存されます。まだ飲んでいない場合は空のままで構いません。"
						>
							<TastingFields
								value={tastingDraft}
								onChange={(patch) =>
									setTastingDraft((d) => ({ ...d, ...patch }))
								}
								idPrefix="wine-tasting"
							/>
						</FormSection>
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

			<LabelSuggestionDiffDialog
				open={labelDiffs.length > 0}
				diffs={labelDiffs}
				onApply={applySelectedLabelDiffs}
				onOpenChange={(open) => {
					if (!open) setLabelDiffs([]);
				}}
			/>

			{/* 未保存のまま離脱しようとしたら警告する(保存直後の遷移は除く) */}
			<UnsavedChangesGuard
				shouldBlock={() => !leavingAfterSaveRef.current && isDirty()}
			/>
		</form>
	);
}
