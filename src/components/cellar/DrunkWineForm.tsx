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
	submitLabelAnalysisJob,
} from "#/components/cellar/label-analysis";
import {
	buildLabelDiffs,
	type LabelDiffItem,
} from "#/components/cellar/label-suggestion-diff";
import {
	acceptPhotoFiles,
	detachPhotoFiles,
} from "#/components/cellar/photo-picker";
import { downscaleImage } from "#/components/cellar/photo-resize";
import {
	EMPTY_SIGHTING_DRAFT,
	SightingFields,
	type WineSightingDraft,
} from "#/components/cellar/SightingFields";
import { buildCreateEntrySightingInput } from "#/components/cellar/sighting-payload";
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
import { isTerminalLabelJobStatus } from "#/lib/ai/label-job";
import { costToCredits } from "#/lib/credit/credit-math";
import {
	CREDIT_BALANCE_QUERY_KEY,
	useCreditBalanceValue,
} from "#/lib/credit/use-credit";
import { hasDrunkWinePatch } from "#/lib/drunk-wine/fields";
import {
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
import type { PlaceEntry } from "#/lib/services/place-service";
import { cn } from "#/lib/utils";
import {
	attachLabelAnalysisJobEntry,
	consumeLabelAnalysisJob,
	getLabelAnalysisPlan,
} from "#/server/ai";
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
	 * 目撃記録の入力に出す場所の候補(#495)。**渡すと新規作成時に「見かけた記録」の
	 * セクションが出る**。編集時は SightingList が銘柄の外で担当するので渡さない。
	 */
	places?: PlaceEntry[];
	/**
	 * 新規作成時の目撃記録の初期値(写真ウィザードからの引き継ぎ #495)。
	 * `places` を渡していないときは意味を持たない。
	 */
	initialSighting?: WineSightingDraft;
	/**
	 * 完了したエチケット解析ジョブの結果を、開いた直後に差分ダイアログで提示する(#472)。
	 *
	 * 解析を開始した時点で記録され(#490)、完了を待たずに離脱した回の受け取り口。
	 * **解析は走らせない**(結果は既にサーバに
	 * ある)し、**自動反映もしない**——宛先は保存済みのワインで、利用者がその後に手で
	 * 直している可能性がある。上書きしてよいかは選ばせる。
	 */
	pendingLabelJob?: { jobId: string; suggestions: LabelSuggestions };
	/**
	 * このフォームの内容がどの解析ジョブの結果か(#474)。**候補は `initialValues` に
	 * 入れて渡す前提**で、こちらは由来だけを伝える。
	 *
	 * 保存できた時点で、そのジョブが解析に使った写真をこのワインの写真として引き継ぐ。
	 * `pendingLabelJob` と分けるのは、あちらが「保存済みのワインに差分として提示する」
	 * のに対し、こちらは新規登録で**既に初期値に反映済み**だから——同じ値をダイアログに
	 * 出すと差分ゼロになり、「クレジットは消費されています」という無関係な案内が出る。
	 */
	sourceLabelJobId?: string;
	/**
	 * そのジョブが解析に使った写真の表示URL(#498)。**読み取り専用のプレビュー**として
	 * 出す。写真UI(追加・削除・並べ替え)には載せられない——実体は R2 にあってブラウザに
	 * `File` が無く、キーがこのワインのものになるのは保存の後だから。
	 */
	sourceLabelJobPhotoUrls?: string[];
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
	places,
	initialSighting,
	pendingLabelJob,
	sourceLabelJobId,
	sourceLabelJobPhotoUrls,
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
	// 新規作成時にだけ使う「見かけた記録」1件(#495)。写真ウィザードで入力した場所・
	// 見かけた日が引き継がれてくる。編集時は SightingList が担当するので触らない。
	const [sightingDraft, setSightingDraft] = useState<WineSightingDraft>(
		() => (entry ? undefined : initialSighting) ?? EMPTY_SIGHTING_DRAFT,
	);
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
	// 同じものを描画の出し分けに使うための state(#490)。解析の投入で保存した後は
	// この画面に留まり続けるので、「もう記録済みか」が表示に効くようになった。
	const [savedEntry, setSavedEntry] = useState<DrunkWineEntry | null>(null);
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
			sighting: sightingDraft,
			initialPhotoKeys: (baseline?.photoUrls ?? []).map(imageKeyFromPath),
			photoKeys: photos.map((p) => (p.kind === "existing" ? p.key : null)),
		});

	// キャッシュバスタは**直近に保存した内容**を基準にする。解析の投入で保存した回
	// (#490)は entry prop のまま画面に留まるので、初期表示時のスナップショットだけを
	// 見ていると保存で入れ替わった写真が古いまま出る。
	const photoVersion = savedEntry?.updatedAt ?? entry?.updatedAt ?? "";

	// 既存写真の表示URL(キャッシュバスタ付き)。解析時のfetchにも使う
	const photoSrc = (p: PhotoItem): string =>
		p.kind === "new"
			? p.previewUrl
			: `${imagePathForKey(p.key)}?v=${photoVersion}`;

	// 一覧と同じく、表示用には縮小版を読む(#237)。実体が無ければ配信側が原寸を返す。
	const photoThumbSrc = (p: PhotoItem): string =>
		p.kind === "new"
			? p.previewUrl
			: `${imagePathForKey(thumbKeyForPhotoKey(p.key))}?v=${photoVersion}`;

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		// 同じファイルを続けて選べるよう、また選択と実アップロードが乖離しないよう毎回リセット
		e.target.value = "";
		if (files.length === 0) return;

		// 形式・サイズ・枚数の判定は写真選択の共通処理に寄せる(#469)。以前はここに
		// 同じ判定が別途書かれており、まとめて登録側にだけ手が入る形になっていた。
		const { accepted, rejectMessage } = acceptPhotoFiles(
			files,
			photos.length,
			MAX_PHOTOS_PER_ENTRY,
		);
		// **選んだ瞬間に中身を掴む**(#469)。解析(数十秒)を挟んでから保存するので、
		// 端末側でファイルが回収されると保存だけが送信前に落ちる。
		const detached = await detachPhotoFiles(accepted);
		setError(detached.rejectMessage || rejectMessage);
		setAnalyzeNotice("");
		if (detached.accepted.length === 0) return;
		setPhotos((prev) => [
			...prev,
			...detached.accepted.map(
				(file): PhotoItem => ({
					localId: `n${newIdRef.current++}`,
					kind: "new",
					file,
					previewUrl: URL.createObjectURL(file),
				}),
			),
		]);
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
	 * 解析結果(候補)をフォームに反映する。**投入経路と受け取り経路で共有する**——
	 * 差分の作り方と提示の仕方を経路ごとに書くと、片方だけ産地の排他規則を落とすような
	 * ドリフトが起きる(#362 でその適用ルールを buildLabelDiffs に寄せたのと同じ理由)。
	 *
	 * **常にダイアログで選ばせる**。自動実行(#416/#464)は #474 で廃止したので、この関数を
	 * 通る解析はどれも利用者が押して始めたものになった。押していない処理が入力を書き換える
	 * 経路はもう無い。
	 */
	const applyLabelSuggestions = (suggestions: LabelSuggestions) => {
		// 「未入力の項目にしか反映しない」自動適用だと、写真追加やエンジン切替での
		// 再解析結果が一切伝わらずクレジットだけ消費される(#362)。差分がある項目を
		// ダイアログで提示し、反映するかどうかをユーザに選ばせる。
		const diffs = buildLabelDiffs(values, suggestions);
		if (diffs.length === 0) {
			setAnalyzeNotice(
				"今回の解析結果と現在の入力に差分はありませんでした(クレジットは消費されています)",
			);
			return;
		}
		setLabelDiffs(diffs);
	};

	/** 添付中の写真を解析ソースへ。既存写真はURL(同一オリジン)、新規はFile。 */
	const analysisSources = (): AnalysisPhotoSource[] =>
		photos.map((p) => (p.kind === "new" ? p.file : { url: photoSrc(p) }));

	/**
	 * いまの入力をサーバへ保存する(新規なら作成、既存なら差分更新)。写真は entryId が
	 * 決まってからでないと R2 キーが作れないので、確定後に集合を同期する。
	 *
	 * 「記録する/更新する」と、解析の投入時の自動記録(#490)が共有する。保存の組み立てを
	 * 経路ごとに書くと、片方だけ目撃記録や写真の同期を落とす形でドリフトする。
	 */
	const persistForm = async (): Promise<DrunkWineEntry> => {
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
			// 新規作成は銘柄・飲用記録・目撃記録を1リクエストで作る(サービス層が
			// db.batch で原子化する)。写真だけは R2 キーが entryId 依存なので
			// 2段階のまま。
			saved = await createDrunkWine({
				data: buildCreateInput(
					state,
					buildTastingInput(tastingDraft),
					// 目撃記録の入力欄を出していない画面(編集)では下書きが空のままなので
					// undefined になり、記録は作られない
					buildCreateEntrySightingInput(sightingDraft),
				),
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
	};

	/**
	 * 保存で確定した内容をフォームへ写す(#490)。保存後もこの画面に留まる経路
	 * (解析の投入時の自動記録)があるので、**保存直後のフォームは「保存済みの状態」を
	 * 映していなければならない**——さもないと離脱ガードが「未保存の変更あり」と言い続け、
	 * 次の保存で同じ写真をもう一度アップロードすることになる。
	 *
	 * 飲用記録・目撃記録の下書きは作成時に1件として保存済みなので空へ戻す。以降の保存は
	 * 差分更新の経路に入り下書きを送らないため、残したままにすると「入力欄に見えているのに
	 * 保存されない」欄になる(入力欄自体もここから出さなくなる)。
	 */
	const applySavedEntry = (saved: DrunkWineEntry) => {
		for (const p of photos) {
			if (p.kind === "new") URL.revokeObjectURL(p.previewUrl);
		}
		setPhotos(
			saved.photoUrls.map((url, i) => ({
				localId: `s${i}`,
				kind: "existing" as const,
				key: imageKeyFromPath(url),
			})),
		);
		setTastingDraft(EMPTY_TASTING_DRAFT);
		setSightingDraft(EMPTY_SIGHTING_DRAFT);
		setSavedEntry(saved);
	};

	// ---- 解析はすべてジョブ経路(#462 / #464) ----
	//
	// 投入が返った時点でサーバに予約と写真が載っているので、**ここから先はページを
	// 離れてよい**。フォームに留まっていればポーリングが完了を拾い、離脱した場合は
	// マイセラーのバッジから受け取れる。
	//
	// **自動実行(#416 の引き継ぎ直後)も同じ経路を通る**(#464)。以前ここだけ同期だった
	// のは「画面到達時に結果が入っていることが体験の要」という理由だったが、フォームには
	// 一括抽出の候補が既に初期値として入っているので空にはならない。エチケット解析は
	// それを精緻化するものなので、17〜31秒(#463 の本番実測)拘束する必要が無い。
	const [jobId, setJobId] = useState<string | null>(null);
	const { data: job, isError: jobUnavailable } = useLabelAnalysisJob(jobId);
	/**
	 * 走っているジョブに保存先を教える(#472)。**best-effort**——保存は既に成功して
	 * おり、紐づけの失敗で利用者の操作を止める理由が無い(受け取りが従来どおり新規作成
	 * モードへ落ちるだけ)。
	 *
	 * 保存の直後だけでなく、既存エントリの編集中に投入した回もここを通す。「この解析結果が
	 * どのワインに宛てられているか」は投入と保存のどちらが先でも同じ意味を持つ。
	 */
	const attachJobToEntry = (
		targetJobId: string,
		targetEntryId: string,
		/**
		 * 解析に使った写真をそのエントリへ引き継がせるか(#490)。**このフォームが投入した
		 * ジョブでは引き継がせない**——投入と同時に同じ写真をエントリへ保存しており、
		 * 引き継ぐと同じ写真が2枚並ぶ。引き継ぐのは、写真を持たずに結果だけを受け取った
		 * 回(`sourceLabelJobId`)だけ。
		 */
		adoptPhotos: boolean,
	) => {
		void attachLabelAnalysisJobEntry({
			data: { jobId: targetJobId, entryId: targetEntryId, adoptPhotos },
		}).catch(() => {});
	};
	// 完了を1回だけ処理する。ポーリングは終端で止まるが、その最後の1件が
	// 再レンダリングのたびに流れ込まないようにする。
	const handledJobRef = useRef<string | null>(null);

	// 解析の投入は「投入 → その時点の内容を記録」の2段(#490)。順序に意味がある:
	//
	//  - **投入が先**。残高不足(`blocked`)で解析が始まらない回に、押しただけで記録が
	//    増えるのはおかしい。投入が通った回だけ記録する
	//  - **記録の失敗で投入を巻き戻さない**。予約は既に立っており、結果はマイセラーの
	//    バッジから受け取れる。名前が空のまま解析させる使い方(AIに名前を読ませる)も
	//    ここに落ちる——保存できないだけで、解析そのものは成立する
	const { mutate: startAnalysisJob, isPending: isSubmittingJob } = useMutation({
		mutationFn: async () => {
			if (photos.length === 0) throw new Error("写真を選択してください");
			const result = await submitLabelAnalysisJob(analysisSources());
			if (result.blocked) return { result, saved: null, saveError: null };
			return await persistForm().then(
				(saved) => ({ result, saved, saveError: null }),
				(e: unknown) => ({
					result,
					saved: null,
					saveError: e instanceof Error ? e.message : String(e),
				}),
			);
		},
		onSuccess: ({ result, saved, saveError }) => {
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
			if (saved) applySavedEntry(saved);
			// 宛先が決まったので、この時点で教えておく。解析中に離脱しても、完了の
			// 受け取りが新規登録ではなく「このワインを編集」へ向く(#472)。
			const target = saved ?? savedRef.current ?? entry;
			if (target) attachJobToEntry(result.jobId, target.id, false);
			if (saveError) {
				setError(
					`解析は開始しましたが、この時点の内容を記録できませんでした(${saveError})。解析の完了後にもう一度保存してください。`,
				);
				setAnalyzeNotice("");
				return;
			}
			setAnalyzeNotice(
				"解析を開始しました。この時点の内容は記録済みです。完了までこのページを離れても構いません(マイセラーから結果を受け取れます)。",
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
		// **この画面で結果を受け取ったジョブは受け取り済みにする**(#472)。しないと
		// 成功したジョブは `succeeded` のまま `consumed_at` が null で残り、目の前で
		// 反映したはずの結果がマイセラーのバッジに「解析が完了しました」として並ぶ。
		// そこから開く導線は新規登録なので、同じワインを2件作る入口になっていた。
		if (job.status === "succeeded") {
			void consumeLabelAnalysisJob({ data: { jobId: job.jobId } }).catch(
				() => {},
			);
		}
		// 実測での確定が済んでいるので残高を引き直す(予約時との差分が戻っている)。
		void queryClient.invalidateQueries({ queryKey: CREDIT_BALANCE_QUERY_KEY });
		void queryClient.invalidateQueries({ queryKey: LABEL_JOB_BADGE_QUERY_KEY });
		if (job.status === "failed" || !job.suggestions) {
			setError(job.error || "エチケットの解析に失敗しました");
			setAnalyzeNotice("");
			return;
		}
		setAnalyzeNotice("");
		applyLabelSuggestions(job.suggestions);
	}, [job, queryClient]);

	// 離脱後に完了したジョブの受け取り(#472)。**解析は走らせない**——結果は既にサーバに
	// あるので、差分ダイアログに載せて反映するかどうかを選ばせるだけ。提示できた時点で
	// 受け取り済みにする(バッジから消し、同じ結果で二度目の登録に進めないようにする)。
	//
	// biome-ignore lint/correctness/useExhaustiveDependencies: 受け取りは1回だけ
	useEffect(() => {
		if (!pendingLabelJob || handledJobRef.current === pendingLabelJob.jobId) {
			return;
		}
		handledJobRef.current = pendingLabelJob.jobId;
		applyLabelSuggestions(pendingLabelJob.suggestions);
		void consumeLabelAnalysisJob({ data: { jobId: pendingLabelJob.jobId } })
			.then(() =>
				queryClient.invalidateQueries({ queryKey: LABEL_JOB_BADGE_QUERY_KEY }),
			)
			.catch(() => {});
	}, [pendingLabelJob, queryClient]);

	// 引き継ぎ直後の自動解析(#416 → #464)は**廃止した**(#474)。写真ウィザードの解析が
	// web検索で裏を取るようになったので、同じ写真をもう一度解析しても得られるものが
	// ほぼ無く、クレジットだけを2回消費していた。裏取りの結果はフォームの初期値に既に
	// 入っている。手動の「エチケットから自動入力」は残す——写真を足した・エンジンを
	// 変えたときに掛け直す用途があり、そちらは利用者が押して初めて走る。

	/**
	 * 解析中(投入待ち + 状態が分かる前 + ジョブ実行中)。保存を止める判定でもある(#490)。
	 *
	 * **状態をまだ引けていない間(`job === undefined`)も解析中として扱う**。投入が返って
	 * から最初のポーリングが返るまでの数百ミリ秒だけ「解析中なのに保存できる」窓ができ、
	 * 実機ではそこを踏んだ(投入直後に保存ボタンが「更新する」に戻る)。
	 *
	 * 状態取得が失敗し続ける回だけは解除する。開かないボタンを押し続けさせるより、
	 * 保存できるほうがまし(離脱ガードも同じ流儀で「保存の道を塞がない」を採る)。
	 */
	const isAnalyzing =
		isSubmittingJob ||
		(jobId !== null &&
			!jobUnavailable &&
			(job === undefined || !isTerminalLabelJobStatus(job.status)));

	const { mutate: save, isPending } = useMutation({
		mutationFn: persistForm,
		onSuccess: async (saved) => {
			// 解析結果の行き先をジョブに教える(#472)。この直後に画面を離れても、完了の
			// 受け取りが新規登録ではなく「このワインを編集」へ向くようになる。
			//
			// **写真を引き継がせるのは `sourceLabelJobId` だけ**(#490)。この画面で投入した
			// 回(`jobId`)と、宛先が既にこのワインのジョブ(`pendingLabelJob`)は、解析に
			// 使った写真と同じものをフォームが保存済みなので、引き継ぐと2枚に増える。
			// `sourceLabelJobId` は手元に File が無い受け取り経路(#474)で、サーバ側の
			// 写真だけが頼り。
			//
			// 関係するジョブが複数ある回(受け取った結果を見てから解析し直した等)は
			// **どれも宛先を記録する**。1件しか記録しないと、残りの完了が新規登録の口を
			// 開いたままになる。
			if (jobId) attachJobToEntry(jobId, saved.id, false);
			if (pendingLabelJob) {
				attachJobToEntry(pendingLabelJob.jobId, saved.id, false);
			}
			if (sourceLabelJobId && sourceLabelJobId !== jobId) {
				attachJobToEntry(sourceLabelJobId, saved.id, true);
			}
			applySavedEntry(saved);
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

				{/*
				  解析に使った写真(#498)。**この写真UIでは扱えない**——実体は R2 にあり、
				  ブラウザに File が無く、キーがこのワインのものになるのは保存の後
				  (サーバが adoptLabelJobPhotos で移す)。削除・並べ替えは保存後の編集で
				  できるので、ここでは「保存すると一緒に残る」ことだけを見せる。
				*/}
				{sourceLabelJobPhotoUrls && sourceLabelJobPhotoUrls.length > 0 && (
					<div className="flex flex-col gap-2">
						<p className="text-xs text-muted-foreground">
							解析に使った写真です。記録するとこのワインの写真として一緒に保存されます(保存後に削除・並べ替えできます)。
						</p>
						<ul className="flex flex-wrap gap-3">
							{sourceLabelJobPhotoUrls.map((url, index) => (
								<li
									key={url}
									className="h-24 w-24 rounded-md border border-dashed border-border"
								>
									<img
										src={url}
										alt={`解析に使った写真${index + 1}`}
										className="h-full w-full rounded-md object-cover"
										loading="lazy"
										decoding="async"
										width={96}
										height={96}
									/>
								</li>
							))}
						</ul>
					</div>
				)}

				<div className="flex flex-col gap-2">
					<Input
						id="wine-photo"
						ref={fileInputRef}
						type="file"
						accept={PHOTO_ACCEPT_ATTR}
						multiple
						onChange={(e) => void handleFileChange(e)}
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
					// 記録済み(解析の投入で保存した回 #490)になったら下書きの入力欄は出さない。
					// 以降の保存は差分更新の経路に入り下書きを送らないので、出したままにすると
					// 「入力できるのに保存されない」欄になる。追加は保存後の編集画面から。
					tastingSlot ??
					(savedEntry ? null : (
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
					))
				}
				sightingSlot={
					// 新規作成で場所の候補を渡されたときだけ。編集画面の目撃記録は
					// SightingList(銘柄の外)が担当する。記録済みになったら出さないのは
					// 飲んだ記録と同じ理由。
					!entry &&
					!savedEntry &&
					places && (
						<FormSection
							title="見かけた記録(任意)"
							description="お店で見かけた場所や日付を入れると、見かけた記録として保存されます。写真から登録した場合は、そこで入力した内容が入っています。"
						>
							<SightingFields
								value={sightingDraft}
								onChange={(patch) =>
									setSightingDraft((d) => ({ ...d, ...patch }))
								}
								places={places}
								idPrefix="wine-sighting"
								allowNewPlace
							/>
						</FormSection>
					)
				}
			/>

			{/* 送信失敗は対処が要るので assertive。空でもコンテナを残さないと読み上げられない(#239) */}
			<LiveRegion tone="alert" className="empty:-mt-6">
				{error && <p className="text-sm text-destructive">{error}</p>}
			</LiveRegion>

			{/*
			  解析中は保存させない(#490)。投入した時点の内容はそこで記録済みで、完了すると
			  差分ダイアログから反映できる。ここで保存できると、同じ写真を解析ジョブとフォームの
			  両方から足す・完了の受け取りが宛先を見失うといった取り違えが起きる。
			*/}
			<LiveRegion className="empty:-mt-6">
				{isAnalyzing && (
					<p className="text-sm text-muted-foreground">
						エチケット解析中です。開始した時点の内容は記録済みなので、完了するまで保存できません。
					</p>
				)}
			</LiveRegion>

			<Button
				type="submit"
				disabled={isPending || isAnalyzing || !values.name.trim()}
				className="self-start"
			>
				{isPending
					? "保存中..."
					: isAnalyzing
						? "解析の完了待ち..."
						: entry || savedEntry
							? "更新する"
							: "記録する"}
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
