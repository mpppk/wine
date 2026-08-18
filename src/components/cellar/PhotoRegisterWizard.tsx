import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ListChecksIcon, PencilIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	analyzeBlockReason,
	photoSetKey,
} from "#/components/cellar/analysis-gate";
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
import {
	consumeLabelAnalysisJob,
	submitLabelAnalysisJob,
} from "#/components/cellar/label-analysis";
import {
	acceptPhotoFiles,
	detachPhotoFiles,
	remainingPhotoSlots,
} from "#/components/cellar/photo-picker";
import { fetchBatchPhotoFiles } from "#/components/cellar/rescan-photos";
import {
	EMPTY_SIGHTING_DRAFT,
	NEW_PLACE_VALUE,
	type WineSightingDraft,
} from "#/components/cellar/SightingFields";
import {
	buildSingleWineHandoff,
	type ManualFormStart,
	singleWineCandidate,
	takePhotosForEntry,
} from "#/components/cellar/single-wine-handoff";
import { UnsavedChangesGuard } from "#/components/cellar/UnsavedChangesGuard";
import {
	LABEL_JOB_BADGE_QUERY_KEY,
	useLabelAnalysisJob,
} from "#/components/cellar/use-label-analysis-job";
import { uploadImportBatchPhotos } from "#/components/cellar/wine-list-analysis";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
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
import {
	estimateWineListReserveCharge,
	type WineListRoute,
} from "#/lib/ai/config";
import { costToCredits } from "#/lib/credit/credit-math";
import {
	CREDIT_BALANCE_QUERY_KEY,
	useCreditBalanceValue,
} from "#/lib/credit/use-credit";
import { todayCalendarDate } from "#/lib/date/calendar-date";
import { formatDateTimeJst } from "#/lib/date/display";
import {
	MAX_PHOTO_SIZE_LABEL,
	PHOTO_ACCEPT_ATTR,
	PHOTO_FORMATS_LABEL_JA,
} from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import type {
	WineListAnalysisOutcome,
	WineListAnalysisSummary,
} from "#/lib/services/ai-service";
import type { LabelJobSighting } from "#/lib/services/label-job-service";
import type { PlaceEntry } from "#/lib/services/place-service";
import { cn } from "#/lib/utils";
import { adoptLabelJobPhotosToBatch } from "#/server/ai";
import { bulkRegisterFromScan, undoImportBatch } from "#/server/place";

// 写真からのワイン登録ウィザード(Issue #358)。「ワインを記録」(/cellar/new)の
// 既定の流れで、3ステップ:
//  1. 撮影/選択 — 写真(≤10枚)+ 写真の場所 + 撮影日 → 解析(AIクレジットを消費)
//  2. レビュー — 検出した銘柄をカードで確認・編集・取捨選択
//  3. 確定 — bulkRegisterFromScan(原子的)→ 写真の実体をアップロード
//
// 1本のワインのエチケットだけが写っていた場合は、2 のレビューではなく単体の記録
// フォームへ切り替える(onSwitchToManual)。ステップ1の「手動で入力」も同じ口から
// 出る——呼び出し側(/cellar/new)がフォームの表示を持ち、このコンポーネントは
// **アンマウントされずに hidden で生き残る**(解析済みの cards はクレジットを
// 消費して得たものなので、戻ってきたときに消えていてはいけない)。
//
// AIクレジットを使うのは Step 1 の解析だけ。Step 2 の内容を失うと**やり直しに
// クレジットがもう一度かかる**ので、離脱ガードを必ず出す(#238 と同じ理由)。

const NEW_PLACE = "__new__";
const NO_PLACE = "__none__";

/**
 * 写真N枚を解析するのに要るクレジット(サーバ側の予約見積と同じ式)。0枚は1枚と同じ。
 * 経路(Luna / Claude)で単価が桁で違うので、実際に走る経路で見積る(#426)。
 */
function creditsForPhotos(route: WineListRoute, count: number): number {
	return costToCredits(estimateWineListReserveCharge(route, count).microUsd);
}

/** 再解析の元になる一括登録バッチ(#427)。 */
interface RescanSource {
	batchId: string;
	/** 保存済み写真の相対URL。**この順が目撃記録の photoIndex の順**。 */
	photoUrls: string[];
	placeId: string | null;
	seenOn: string | null;
	createdAt: number;
}

/** 選択中の写真1枚。プレビューURLは解放が要るので localId で同定する。 */
interface PhotoItem {
	localId: string;
	file: File;
	previewUrl: string;
	/**
	 * どこから来た写真か。再解析(#427)は元バッチの写真が入った状態で始まり、
	 * そこへ撮り忘れたページを足せる(#428)。**どれが元の写真かをサムネイルに出す**
	 * ために持つ——足したつもりのページを撮り違えても気付けないため。
	 */
	source: "rescan" | "picked";
}

export interface PhotoRegisterWizardProps {
	/** 「写真の場所」の候補(ユーザ単位のマスタ)。 */
	places: PlaceEntry[];
	/**
	 * 一括抽出で実際に走る経路(サーバが解決したもの)。必要クレジットの表示に使う。
	 * このコンポーネントは経路が解決できた環境でしか描画されない(#426)。
	 */
	route: WineListRoute;
	/**
	 * 過去の一括登録をやり直す場合の元バッチ(Issue #427)。写真・場所・見かけた日を
	 * ここから初期化する。**元バッチは書き換えない**——確定すると新しいバッチができ、
	 * 既に登録済みの銘柄はレビュー画面に「既存に追加」として出る(distinct の第2段)。
	 */
	rescan?: RescanSource;
	/**
	 * このウィザードが表示されているか。単体の記録フォームへ切り替えている間は
	 * false になり、離脱ガードを黙らせる(フォーム側のガードと二重に出さない)。
	 */
	active: boolean;
	/**
	 * 単体の記録フォームへ切り替える(単一ワイン判定 / 「手動で入力」)。
	 *
	 * 切り替えの時点では**まだ何も登録していない**(バッチも目撃記録も作らない)。
	 * プレビュー用の blob URL も解放しない——このウィザードは hidden で生き残り、
	 * ユーザが戻ってきたときに同じサムネイルを出し直す必要があるため。
	 */
	onSwitchToManual: (start: ManualFormStart) => void;
	/**
	 * バッジから受け取った完了済みの一括抽出ジョブ(#474)。**投入せずに結果だけを持って
	 * 始まる**回で、写真は手元に無い(離脱しているので当然)——登録時はサーバに残っている
	 * 解析用の写真をそのままバッチへ渡す。
	 */
	receivedJob?: {
		jobId: string;
		result: WineListAnalysisOutcome;
		/**
		 * ジョブが解析に使った写真の枚数。**手元の `File` の枚数では代用できない**——
		 * 受け取って開いた回はブラウザに実体が無く0枚だが、候補は `photoIndexes` で
		 * その写真を指しているため、0 を送ると「写真の番号が、送信する写真の枚数を
		 * 超えています」で登録ごと弾かれる(#482 の本番確認で踏んだ)。
		 */
		photoCount: number;
		/**
		 * 投入時に入力されていた「どこで・いつ撮ったか」(#498)。ジョブに残してあるので、
		 * 受け取って開いた回でも場所・撮影日を選び直させずに復元する。
		 */
		sighting?: LabelJobSighting;
	};
}

export function PhotoRegisterWizard({
	places,
	route,
	rescan,
	active,
	onSwitchToManual,
	receivedJob,
}: PhotoRegisterWizardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [photos, setPhotos] = useState<PhotoItem[]>([]);
	// 再解析なら元バッチの場所・見かけた日を、受け取って開いた回(#498)なら投入時の
	// 入力を引き継ぐ(どちらも同じ機会の記録なので、選び直させる意味が無い)。
	// 写真の読み込みだけは非同期なので effect で入れる。
	const [placeChoice, setPlaceChoice] = useState<string>(() => {
		if (rescan?.placeId) return rescan.placeId;
		if (receivedJob?.sighting?.placeId) return receivedJob.sighting.placeId;
		if (receivedJob?.sighting?.newPlaceName) return NEW_PLACE;
		return NO_PLACE;
	});
	const [newPlaceName, setNewPlaceName] = useState(
		() => receivedJob?.sighting?.newPlaceName ?? "",
	);
	const [seenOn, setSeenOn] = useState(
		() =>
			rescan?.seenOn ?? receivedJob?.sighting?.seenOn ?? todayCalendarDate(),
	);
	// 保存済み写真の読み込み状態。再解析でないときは常に false / 空。
	const [loadingRescanPhotos, setLoadingRescanPhotos] = useState(!!rescan);
	const [cards, setCards] = useState<ImportCardState[] | null>(null);
	// いま出している画面。**`cards` の有無から導出しない**。以前は「写真の選択に戻る」で
	// `cards` を捨てていたため、戻ると同じ写真のまま解析ボタンが押せて、同じ結果に
	// クレジットをもう一度払えた。結果は残したまま画面だけ切り替える。
	const [step, setStep] = useState<"photos" | "review">("photos");
	// 解析済みの写真の印(`photoSetKey`)。同じ写真での解析の押し直しを止める。
	const [analyzedPhotoKey, setAnalyzedPhotoKey] = useState<string | null>(null);
	const [summary, setSummary] = useState<WineListAnalysisSummary | null>(null);
	const [error, setError] = useState("");
	const [showInsufficient, setShowInsufficient] = useState(false);
	// 登録(server fn)が通った後の結果。写真アップロードだけ失敗したときの
	// 再試行で二重登録しないための印でもある
	const [registered, setRegistered] = useState<Awaited<
		ReturnType<typeof bulkRegisterFromScan>
	> | null>(null);
	// 記録+写真まで含めて完了したら true。完了画面(取り消し導線あり)を出す。
	const [completed, setCompleted] = useState(false);
	const [undoOpen, setUndoOpen] = useState(false);
	const [undoError, setUndoError] = useState("");
	const newIdRef = useRef(0);
	const doneRef = useRef(false);
	// 撮影日の初期値(今日)。「ユーザが触ったか」の判定に使う——既定のままなら
	// 記録フォームへ切り替えても失うものは無いので、目撃記録として引き継がない。
	//
	// **復元した値は既定として扱わない**(#498)。再解析の元バッチ・受け取ったジョブから
	// 入った日付は利用者が一度入力したものなので、`todayCalendarDate()` を基準に置いて
	// 「触られた」側に倒す(基準を復元値にすると、同じ日付が黙って落ちる)。
	const defaultSeenOnRef = useRef(todayCalendarDate());

	// 解析を押す前に「この枚数でいくら要るか」を出す。押してから残高不足で弾かれると、
	// 写真を選び直す手間だけが無駄になる(サーバ側の予約 estimateWineListReserveTokens と
	// 同じ式を共有するので、見積を変えても表示だけ古くなることはない)。
	const requiredCredits = creditsForPhotos(route, photos.length);
	// あと何枚足せるか。再解析では元バッチの写真を含めた残りになる(#428)
	const remainingSlots = remainingPhotoSlots(photos.length);
	// いま選んでいる写真の印。解析済みの印と一致する間は「同じ解析」なので押させない。
	const photoKey = photoSetKey(photos.map((p) => p.localId));
	// null = 未ログイン・取得中・取得失敗。残高0と区別できないので不足判定には使わない
	const balance = useCreditBalanceValue();
	const insufficientCredits = balance !== null && balance < requiredCredits;
	// 枚数を減らせば足りるのか、最小構成でも足りないのかで案内が変わる
	const canFixByFewerPhotos =
		balance !== null && balance >= creditsForPhotos(route, 1);

	// 単一ワイン判定後のエチケット解析の見積は**もう要らない**(#493)。2回目の解析を
	// やめた(#474)ので消費は増えず、見積のためだけに毎回 server fn を叩いていた。

	// 再解析の元写真を読み込む。**1回だけ**走らせる(依存は batchId)——ユーザが
	// 写真を消した後に再取得すると、消したはずの写真が戻ってくる。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 初回の一度だけ読み込む
	useEffect(() => {
		if (!rescan) return;
		let cancelled = false;
		setLoadingRescanPhotos(true);
		fetchBatchPhotoFiles(rescan.photoUrls)
			.then((files) => {
				if (cancelled) return;
				// **置き換えない**。読み込みは非同期なので、待っている間にユーザが
				// 追加の写真を選んでいることがある(#428)。元の写真は先頭に入れる
				// ——この順が目撃記録の photoIndex の順になる
				setPhotos((prev) => [
					...files.map((file) => ({
						localId: `p${newIdRef.current++}`,
						file,
						previewUrl: URL.createObjectURL(file),
						source: "rescan" as const,
					})),
					...prev,
				]);
			})
			.catch((e: Error) => {
				if (cancelled) return;
				setError(e.message || "保存済みの写真を読み込めませんでした");
			})
			.finally(() => {
				if (!cancelled) setLoadingRescanPhotos(false);
			});
		return () => {
			cancelled = true;
		};
	}, [rescan?.batchId]);

	/**
	 * 記録フォームへ渡す目撃記録の下書き(#495)。ユーザが場所・撮影日に触っていなければ
	 * undefined(フォームは空の「見かけた記録」で開く)。
	 *
	 * 撮影日は既定で今日が入っているので、**触っていない既定値は引き継がない**。
	 * 引き継ぐと、1本のエチケットを撮っただけの回にも「今日そこで見かけた」という
	 * 記録が黙って付く。
	 */
	const sightingHandoff = (): WineSightingDraft | undefined => {
		const touchedPlace = placeChoice !== NO_PLACE;
		const touchedSeenOn = seenOn !== defaultSeenOnRef.current;
		if (!touchedPlace && !touchedSeenOn) return undefined;
		return {
			...EMPTY_SIGHTING_DRAFT,
			...(placeChoice === NEW_PLACE
				? { placeId: NEW_PLACE_VALUE, newPlaceName }
				: touchedPlace
					? { placeId: placeChoice }
					: {}),
			// 場所を選んだ回は、既定のままの撮影日も一緒に渡す(「今日そこで見かけた」が
			// この回の記録として意味を持つため)
			seenOn,
		};
	};

	/**
	 * 解析ジョブに残す「どこで・いつ撮ったか」(#498)。判定は記録フォームへの引き継ぎと
	 * 同じ(`sightingHandoff`)にする——投入して離脱した回と、留まって切り替えた回で
	 * 残る内容が違うと、同じ操作なのに結果が変わる。
	 */
	const sightingForJob = (): LabelJobSighting | undefined => {
		const draft = sightingHandoff();
		if (!draft) return undefined;
		return {
			...(draft.placeId === NEW_PLACE_VALUE
				? draft.newPlaceName.trim()
					? { newPlaceName: draft.newPlaceName.trim() }
					: {}
				: draft.placeId
					? { placeId: draft.placeId }
					: {}),
			...(draft.seenOn ? { seenOn: draft.seenOn } : {}),
		};
	};

	const updateCard = (localId: string, patch: Partial<ImportCardState>) => {
		setCards(
			(prev) =>
				prev?.map((c) => (c.localId === localId ? { ...c, ...patch } : c)) ??
				null,
		);
	};

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		e.target.value = "";
		if (files.length === 0) return;
		// 上限は「今ある枚数 + これから足す枚数」で見る。再解析では元バッチの写真が
		// 既に入っているので、選んだファイルだけで判定すると上限を超える(#428)
		const { accepted, rejectMessage } = acceptPhotoFiles(files, photos.length);
		// **選んだ瞬間に中身を掴む**(#469)。ここは解析→レビュー→確定と数分かかる導線で、
		// 端末側でファイルが回収されると最後の写真アップロードだけが送信前に落ちる。
		const detached = await detachPhotoFiles(accepted);
		// 読めなかった理由を優先して出す。枚数超過より利用者の行動が変わる。
		setError(detached.rejectMessage || rejectMessage);
		if (detached.accepted.length === 0) return;
		setPhotos((prev) => [
			...prev,
			...detached.accepted.map((file) => ({
				localId: `p${newIdRef.current++}`,
				file,
				previewUrl: URL.createObjectURL(file),
				source: "picked" as const,
			})),
		]);
	};

	const removePhoto = (localId: string) => {
		setPhotos((prev) => {
			const target = prev.find((p) => p.localId === localId);
			if (target) URL.revokeObjectURL(target.previewUrl);
			return prev.filter((p) => p.localId !== localId);
		});
	};

	// ---- 解析はジョブ経路(#474) ----
	//
	// web検索での裏取りが乗って所要時間が伸びたので、同期で画面を拘束せず「投入したら
	// 離れてよい」へ揃える(エチケット解析と同じ基盤)。投入が返った時点でサーバに予約と
	// 写真が載っているので、完了はここでのポーリングか、離脱した場合はマイセラーの
	// バッジから受け取れる。
	// 受け取って開いた回は、投入せずに結果だけを持って始まる(#474)。
	const [jobId, setJobId] = useState<string | null>(receivedJob?.jobId ?? null);
	/**
	 * 投入済みで結果待ちのジョブ。**解析中かどうかをポーリングの `job` から導出しない**。
	 * 投入が返ってから最初のポーリングが返るまで `job` は `undefined` で、その窓だけ
	 * ボタンが有効に戻り、同じ写真の解析を二重に投入できた(記録フォーム側で #490 が
	 * 塞いだのと同じ穴)。通信が一時的に失敗して状態を引けない間も同じ。
	 */
	const [awaitingJobId, setAwaitingJobId] = useState<string | null>(null);
	const { data: job, error: jobError } = useLabelAnalysisJob(
		// 受け取り済みの結果は既に手元にあるので引き直さない。ただし**この画面から
		// 投入し直したジョブは別物**なので、受け取って開いた回でもポーリングする——
		// 「receivedJob があれば常に引かない」にしていたため、受け取ってから解析し直すと
		// 完了が永久に届かず、ボタンだけが有効なまま何度でも投入できた。
		jobId !== null && jobId !== receivedJob?.jobId ? jobId : null,
	);
	// 反映済みのジョブID。**集合で持つ**——1つのrefだと、解析し直して新しいIDを覚えた
	// 時点で受け取り側の effect の番人が外れ、古い受け取り結果で上書きされる。
	const handledJobIdsRef = useRef<Set<string>>(new Set());
	// 投入した時点の写真の印。完了時に「この写真は解析済み」として覚えるのに使う。
	const analyzingPhotoKeyRef = useRef("");

	const { mutate: analyze, isPending: isSubmittingJob } = useMutation({
		mutationFn: () =>
			submitLabelAnalysisJob(
				photos.map((p) => p.file),
				"wine_list",
				// 完了を待たずに離脱しても場所・撮影日を復元できるようジョブに残す(#498)
				sightingForJob(),
			),
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
			// ここから完了を反映するまでが「解析中」。ポーリングの状態が引けるより先に
			// 立てる(投入直後にボタンが有効へ戻る窓を作らない)。
			setAwaitingJobId(result.jobId);
		},
		onError: (e: Error) => setError(e.message || "解析の受付に失敗しました"),
	});

	/**
	 * 完了した解析結果を画面へ反映する。ポーリングと受け取りの両方が通る。
	 *
	 * `analyzedKey` は**その結果を得た写真の印**(投入時に控えたもの)。ここで覚えて、
	 * 同じ写真での解析の押し直しを止める。
	 */
	const applyWineListResult = (
		result: WineListAnalysisOutcome,
		analyzedKey: string,
	) => {
		setAnalyzedPhotoKey(analyzedKey);
		if (result.candidates.length === 0) {
			// **空のレビュー画面へは進めない**。読み取れなかった回に要るのは撮り直しの
			// 導線であって、0件のカード一覧ではない。写真の画面に留めたまま理由を出す
			// (この写真は解析済みとして印が付くので、変えるまで押し直せない)。
			setError(
				"写真からワインを読み取れませんでした。ワインリストや棚が写るように撮り直してください。",
			);
			return;
		}
		setSummary(result.summary);
		setCards(buildImportCards(result.candidates));
		// 完了したら結果の画面へ自動で進む。押した本人が見ている回に、写真の画面へ
		// 留まったままにしない。
		setStep("review");
		// 1本のワインのエチケット等を撮った写真だった場合は、レビューではなく単体の
		// 記録フォームへ切り替える(#416)。レビュー画面は裏で組み立て済みなので、
		// 誤判定だった場合はフォームから戻ればそのまま一括登録を続けられる。
		const single = singleWineCandidate(result.candidates, result.summary);
		if (single) {
			onSwitchToManual(
				buildSingleWineHandoff(
					single,
					photos.map((p) => p.file),
					sightingHandoff(),
				),
			);
		}
	};

	// 受け取って開いた回(#474)。結果は既に手元にあるので、解析は走らせず反映だけする。
	// 受け取り済みにするのはここ——ローダーではなく画面がマウントされてから(#462 と同じ、
	// `defaultPreload: "intent"` でホバーだけでもローダーが走るため)。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 受け取りは1回だけ
	useEffect(() => {
		if (!receivedJob || handledJobIdsRef.current.has(receivedJob.jobId)) return;
		handledJobIdsRef.current.add(receivedJob.jobId);
		void consumeLabelAnalysisJob(receivedJob.jobId)
			.then(() =>
				queryClient.invalidateQueries({ queryKey: LABEL_JOB_BADGE_QUERY_KEY }),
			)
			.catch(() => {});
		// 受け取った回は手元に写真が無い(離脱しているので当然)。いまの選択(空)を
		// 解析済みの印にしておくと、写真を足すまで解析ボタンが開かない。
		applyWineListResult(receivedJob.result, photoKey);
	}, [receivedJob, queryClient]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 完了の1回だけ処理する
	useEffect(() => {
		if (!job || handledJobIdsRef.current.has(job.jobId)) return;
		if (job.status === "queued" || job.status === "running") return;
		handledJobIdsRef.current.add(job.jobId);
		setAwaitingJobId(null);
		// 実測での確定が済んでいるので残高を引き直す(予約時との差分が戻っている)。
		void queryClient.invalidateQueries({ queryKey: CREDIT_BALANCE_QUERY_KEY });
		void queryClient.invalidateQueries({ queryKey: LABEL_JOB_BADGE_QUERY_KEY });
		if (job.status === "failed" || !job.wineList) {
			// 失敗した回は解析済みの印を付けない(同じ写真でもう一度試せる)。
			setError(job.error || "写真の解析に失敗しました");
			return;
		}
		// **この画面で受け取ったジョブは受け取り済みにする**。しないと、目の前で反映した
		// 結果がマイセラーのバッジに「解析が完了しました」として並び続ける(#472 と同じ)。
		void consumeLabelAnalysisJob(job.jobId).catch(() => {});
		applyWineListResult(job.wineList, analyzingPhotoKeyRef.current);
	}, [job, queryClient]);

	/** 解析中(投入待ち + 結果待ち)。結果を反映するまで下がらない。 */
	const isAnalyzing = isSubmittingJob || awaitingJobId !== null;
	/** 解析を始められない理由。null なら押せる。 */
	const analyzeBlocked = analyzeBlockReason({
		photoKey,
		analyzedPhotoKey,
		photoCount: photos.length,
		analyzing: isAnalyzing,
		loadingPhotos: loadingRescanPhotos,
		insufficientCredits,
		missingPlaceName: placeChoice === NEW_PLACE && !newPlaceName.trim(),
	});

	const goToCellar = async () => {
		for (const p of photos) URL.revokeObjectURL(p.previewUrl);
		doneRef.current = true;
		await navigate({ to: "/cellar", search: { filter: "spotted" } });
	};

	const { mutate: register, isPending: isRegistering } = useMutation({
		mutationFn: async () => {
			if (!cards) throw new Error("解析結果がありません");
			// **既に登録が通っていれば再登録しない**。この経路は「登録(server fn)→
			// 写真アップロード」の2段階で、後半だけ失敗しうる(実機確認で踏んだ)。
			// そのまま再送するとバッチと目撃記録がもう一組できて二重登録になるため、
			// 確定済みの batchId を持ち回して写真の保存だけをやり直す。
			const result =
				registered ??
				(await bulkRegisterFromScan({
					data: buildBulkRegisterInput(cards, {
						...(placeChoice !== NO_PLACE && placeChoice !== NEW_PLACE
							? { placeId: placeChoice }
							: {}),
						...(placeChoice === NEW_PLACE ? { newPlaceName } : {}),
						...(seenOn ? { seenOn } : {}),
						// 受け取って開いた回は手元に File が無く、写真はサーバから引き継ぐ。
						// 申告枚数はその引き継ぎ元の枚数にする(#482)。**手元に写真が
						// あるならそちらを優先する**——受け取った後にこの画面で解析し直した
						// 回は、候補の写真番号が新しく選んだ写真を指しているため。
						photoCount:
							photos.length > 0
								? photos.length
								: (receivedJob?.photoCount ?? 0),
					}),
				}));
			setRegistered(result);
			// 写真の実体は登録確定後(R2キーが batchId 依存)。ここで失敗しても記録は
			// 残っているので、**そのことが伝わる文言に置き換えてから** throw する
			// (onError 側で判定すると、この実行で setRegistered した結果がまだ
			// クロージャに反映されておらず、初回の失敗を「登録に失敗」と誤って出す)。
			try {
				if (photos.length > 0) {
					await uploadImportBatchPhotos(
						result.batchId,
						photos.map((p) => p.file),
					);
				} else if (jobId) {
					// ジョブを受け取って開いた回は手元に File が無い(離脱しているので当然)。
					// 解析に使った写真はサーバに残っているので、そのままバッチへ渡す(#474)。
					await adoptLabelJobPhotosToBatch({
						data: { jobId, batchId: result.batchId },
					});
				}
			} catch (e) {
				const detail = e instanceof Error ? e.message : String(e);
				throw new Error(
					`記録の登録は完了しましたが、写真の保存に失敗しました(${detail})。もう一度試すか、写真なしで完了できます。`,
				);
			}
			return result;
		},
		onSuccess: () => {
			// 記録+写真まで保存済みなので、以降の離脱でクレジット消費が無駄になる
			// リスクはもう無い(離脱ガードの対象から外す)。完了画面(取り消し導線)を出す。
			doneRef.current = true;
			setCompleted(true);
		},
		onError: (e: Error) => setError(e.message || "登録に失敗しました"),
	});

	const { mutate: undoBatch, isPending: isUndoing } = useMutation({
		mutationFn: () => {
			if (!registered) throw new Error("取り消す登録がありません");
			return undoImportBatch({ data: { batchId: registered.batchId } });
		},
		onSuccess: () => void goToCellar(),
		onError: (e: Error) => setUndoError(e.message || "取り消しに失敗しました"),
	});

	const selection = cards ? summarizeImportCards(cards) : null;
	const validation = cards ? validateImportCards(cards) : null;

	return (
		<>
			{completed && registered ? (
				<ImportCompletionScreen
					registered={registered}
					rescanned={!!rescan}
					onUndo={() => setUndoOpen(true)}
					onProceed={() => void goToCellar()}
				/>
			) : step === "photos" || cards === null ? (
				<div className="flex flex-col gap-6">
					{rescan && (
						<div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
							<p>
								{formatDateTimeJst(new Date(rescan.createdAt))}の一括登録を
								{loadingRescanPhotos
									? "読み込んでいます…"
									: `やり直します(写真${photos.length}枚)。`}
							</p>
							<p className="mt-1 text-muted-foreground">
								撮り忘れたページがあれば
								<strong className="font-medium">写真を足してから</strong>
								解析できます。解析し直すとAIクレジットを消費します。元の登録は
								そのまま残り、同じ銘柄と判定できたものは「既存に追加」、
								<strong className="font-medium">
									読み取り方が前回と変わった銘柄は新規
								</strong>
								として出るので、重複させたくないものはチェックを外してください。
								不要になったら履歴から取り消せます。
							</p>
						</div>
					)}
					<div className="flex flex-col gap-3">
						<Label htmlFor="register-photo">
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
										{p.source === "rescan" && (
											// どれが元バッチの写真かが見えないと、足したつもりの
											// ページを撮り違えても気付けない(#428)
											<span className="absolute inset-x-0 bottom-0 rounded-b-md bg-foreground/70 py-0.5 text-center text-[10px] leading-none text-background">
												元の写真
											</span>
										)}
										<button
											type="button"
											aria-label={`写真${index + 1}を削除`}
											// 解析中は写真を触らせない。走っているのは投入した時点の
											// 写真なので、途中で増減すると結果と手元の写真がずれる。
											disabled={isAnalyzing}
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
							id="register-photo"
							type="file"
							accept={PHOTO_ACCEPT_ATTR}
							multiple
							onChange={(e) => void handleFileChange(e)}
							disabled={
								isAnalyzing || photos.length >= MAX_PHOTOS_PER_IMPORT_BATCH
							}
							className="max-w-xs"
						/>
						<p className="text-xs text-muted-foreground">
							{rescan
								? "撮り忘れたページや棚の続きを足せます。"
								: "ワインのエチケット(ラベル)や、レストランのワインリスト・ショップの棚を撮った写真を選んでください。"}
							{PHOTO_FORMATS_LABEL_JA}、各{MAX_PHOTO_SIZE_LABEL}まで。
							同じワインが複数の写真に写っていても1件にまとめます。
							{/*
							  残り枚数は明示する。無言で disabled にすると「なぜ選べないのか」が
							  分からない——再解析では元バッチの写真で既に枠が埋まっていることがある(#428)
							*/}
							{remainingSlots > 0
								? `あと${remainingSlots}枚まで追加できます。`
								: `写真は最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚までです。追加するには、どれかを外してください。`}
						</p>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="register-place">写真の場所(任意)</Label>
						<Select value={placeChoice} onValueChange={setPlaceChoice}>
							<SelectTrigger id="register-place" className="w-full">
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
						<Label htmlFor="register-seen-on">撮影日</Label>
						<Input
							id="register-seen-on"
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
						<div className="flex flex-wrap items-center gap-2">
							{/*
							  解析結果は「写真の選択に戻る」でも捨てないので、いつでも見に戻れる。
							  結果があるときはこちらが本筋なので、解析ボタンより前・主ボタンで出す。
							*/}
							{cards && (
								<Button
									type="button"
									onClick={() => {
										setError("");
										setStep("review");
									}}
								>
									<ListChecksIcon className="size-4" aria-hidden />
									解析結果を見る({cards.length}件)
								</Button>
							)}
							<Button
								type="button"
								variant={cards ? "outline" : "default"}
								disabled={analyzeBlocked !== null}
								onClick={() => {
									setError("");
									// 完了時に「この写真は解析済み」と覚えるための控え。
									analyzingPhotoKeyRef.current = photoKey;
									analyze();
								}}
							>
								<SparklesIcon className="size-4" aria-hidden />
								{isAnalyzing
									? "解析中…"
									: analyzedPhotoKey !== null
										? "写真を解析し直す"
										: "写真を解析する"}
							</Button>
							{/*
							  写真を使わずに全部自分で書きたい場合の逃げ道。選択済みの写真は
							  そのまま記録フォームへ添付するので、選び直しは要らない。
							*/}
							<Button
								type="button"
								variant="ghost"
								disabled={isAnalyzing}
								onClick={() => {
									const sighting = sightingHandoff();
									onSwitchToManual({
										...takePhotosForEntry(photos.map((p) => p.file)),
										reason: "manual_choice",
										...(sighting ? { sighting } : {}),
									});
								}}
							>
								<PencilIcon className="size-4" aria-hidden />
								手動で入力
							</Button>
						</div>
						{isAnalyzing && (
							// 解析はジョブ経路(#474)。投入が返った時点でサーバに予約と写真が
							// 載っているので、ここから先は離れてよいことを明示する。
							<p className="text-sm" aria-live="polite">
								解析には1〜3分ほどかかります。完了したらこの画面が解析結果に切り替わります。完了までこのページを離れても構いません(マイセラーから結果を受け取れます)。
							</p>
						)}
						{isAnalyzing && jobError && (
							// 状態を引けない間もボタンは開けない(二重投入のほうが高くつく)。
							// 完了はバッジからも受け取れるので、詰みではないことを伝える。
							<p className="text-sm text-muted-foreground">
								解析状況を取得できませんでした(再試行しています)。完了した結果はマイセラーからも受け取れます。
							</p>
						)}
						{analyzeBlocked === "already_analyzed" && (
							// なぜ押せないのかを言わずに disabled にしない。同じ写真の解析は
							// クレジットを払って同じ結果を得るだけなので、行き先を示して止める。
							<p className="text-sm text-muted-foreground">
								この写真は解析済みです。
								{cards
									? "「解析結果を見る」から続けるか、"
									: "同じ写真を解析し直しても結果は変わりません。"}
								写真を追加・削除すると解析し直せます。
							</p>
						)}
						<p className="text-xs text-muted-foreground">
							AIが写真からワインを読み取ります。
							{photos.length > 0
								? `この${photos.length}枚の解析で最大${requiredCredits}クレジット`
								: `写真1枚で最大${creditsForPhotos(route, 1)}クレジット、以降1枚ごとに+${
										creditsForPhotos(route, 2) - creditsForPhotos(route, 1)
									}クレジット`}
							を消費します
							{balance !== null && `(残高 ${balance})`}。
						</p>
						{insufficientCredits ? (
							<p className="text-xs text-destructive">
								クレジットが足りません。
								{canFixByFewerPhotos
									? "写真の枚数を減らすと解析できます。"
									: `この機能には最低${creditsForPhotos(route, 1)}クレジットが必要です。翌月の付与をお待ちいただくか、プレミアムプランをご検討ください。`}
								<Link to="/pricing" className="ml-1 underline">
									プレミアムプランを見る
								</Link>
							</p>
						) : (
							<>
								<p className="text-xs text-muted-foreground">
									{/*
									  所要時間はプレビュー実測で 87秒〜5分(web検索での裏取りを挟むぶん
									  振れる)。以前の「30秒ほど」「最大で数分・画面を閉じないでください」は
									  どちらも実態と合っていない。
									*/}
									解析には1〜3分ほどかかります。完了すると解析結果の画面に切り替わります。
								</p>
								{/*
								  単一ワインと判定したときは記録フォームへ自動で切り替わる(#416)。
								  **2回目の解析は走らない**——#474 で一括抽出にも web検索での裏取りが
								  乗り、「解析を2回する」住み分けをやめたため。以前の文言は追加クレジットの
								  消費を予告していたが、実際には消費しない(#493)。
								*/}
								<p className="text-xs text-muted-foreground">
									1本のワインのエチケットだけが写っていた場合は、そのまま記録フォームに切り替えて、読み取った内容を入力しておきます(追加のクレジットは消費しません)。
								</p>
							</>
						)}
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
								{isRegistering
									? "登録中…"
									: registered
										? "写真の保存を再試行"
										: "マイセラーに登録する"}
							</Button>
							{registered ? (
								<>
									{/* 記録は登録済みなので、写真を諦めて先に進む逃げ道を必ず残す */}
									<Button
										type="button"
										variant="ghost"
										disabled={isRegistering}
										onClick={() => void goToCellar()}
									>
										写真なしで完了する
									</Button>
									{/* 記録(銘柄・目撃記録)は既にできているので、写真の成否に関わらずここから取り消せる */}
									<Button
										type="button"
										variant="ghost"
										disabled={isRegistering}
										onClick={() => setUndoOpen(true)}
									>
										この登録を取り消す
									</Button>
								</>
							) : (
								<Button
									type="button"
									variant="ghost"
									disabled={isRegistering}
									onClick={() => {
										// **解析結果は捨てない**。捨てると、戻った先で同じ写真の
										// 解析ボタンがそのまま押せて、同じ結果にクレジットを
										// もう一度払える(それがこの導線の元の姿だった)。
										setError("");
										setStep("photos");
									}}
								>
									写真の選択に戻る
								</Button>
							)}
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

			<Dialog open={undoOpen} onOpenChange={setUndoOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>この登録を取り消しますか?</DialogTitle>
						<DialogDescription>
							{registered
								? `今回新規作成した${registered.createdCount}件の銘柄と、既存の銘柄に追加した目撃記録を取り消します。写真も削除されます。この操作は取り消せません。`
								: "この操作は取り消せません。"}
						</DialogDescription>
					</DialogHeader>
					{undoError && <p className="text-sm text-destructive">{undoError}</p>}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={isUndoing}
							onClick={() => setUndoOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={isUndoing}
							onClick={() => undoBatch()}
						>
							{isUndoing ? "取り消し中…" : "取り消す"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/*
			  解析はクレジットを消費しているので、レビュー中の離脱は必ず警告する(#238)。
			  記録フォームを表示している間(active=false)は、フォーム側のガードが同じ離脱を
			  押さえるので黙る——両方が useBlocker を張ると確認ダイアログが2回出る。
			*/}
			<UnsavedChangesGuard
				shouldBlock={() => active && !doneRef.current && cards !== null}
			/>
		</>
	);
}

/**
 * 登録完了画面(Issue #363 案A)。記録+写真の保存まで終わった直後だけ出す。
 * 「間違った写真をアップロードしてしまった」に対応するため、マイセラーへ進む前に
 * その場で取り消せる導線をここに置く(バッチ一覧・エントリ詳細からの恒常的な
 * 取り消し導線は設けない。実装プランのスコープ決定を参照)。
 */
function ImportCompletionScreen({
	registered,
	rescanned,
	onUndo,
	onProceed,
}: {
	registered: Awaited<ReturnType<typeof bulkRegisterFromScan>>;
	/** 履歴からの再解析だったか(#427)。元バッチの後始末を案内するために要る。 */
	rescanned: boolean;
	onUndo: () => void;
	onProceed: () => void;
}) {
	return (
		<div className="flex flex-col gap-6">
			<div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
				<p>登録が完了しました。</p>
				<p className="mt-1 text-muted-foreground">
					新規{registered.createdCount}件・既存へ追加{registered.matchedCount}
					件(目撃記録{registered.sightingCount}件
					{registered.tastingCount > 0 &&
						`・飲んだ記録${registered.tastingCount}件`}
					)
				</p>
				{rescanned && (
					// 元バッチは黙って残る。放置すると同じ機会の登録が二重に見えるので、
					// 「取り消す」は取り消し導線が既にある履歴側に任せて場所だけ示す。
					<p className="mt-2 text-muted-foreground">
						やり直す前の登録はそのまま残っています。不要なら
						<Link to="/cellar/import/history" className="mx-1 underline">
							一括登録の履歴
						</Link>
						から取り消せます。
					</p>
				)}
			</div>
			<div className="flex gap-2">
				<Button type="button" onClick={onProceed}>
					マイセラーへ
				</Button>
				<Button type="button" variant="ghost" onClick={onUndo}>
					この登録を取り消す
				</Button>
			</div>
		</div>
	);
}
