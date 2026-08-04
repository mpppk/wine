import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PencilIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { fetchBatchPhotoFiles } from "#/components/cellar/rescan-photos";
import {
	buildSingleWineHandoff,
	MAX_HANDOFF_PHOTOS,
	type ManualFormStart,
	singleWineCandidate,
	takePhotosForEntry,
} from "#/components/cellar/single-wine-handoff";
import { UnsavedChangesGuard } from "#/components/cellar/UnsavedChangesGuard";
import {
	analyzeWineListPhotos,
	uploadImportBatchPhotos,
} from "#/components/cellar/wine-list-analysis";
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
	estimateLabelReserveCharge,
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
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	PHOTO_ACCEPT_ATTR,
	PHOTO_FORMATS_LABEL_JA,
} from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import type { WineListAnalysisSummary } from "#/lib/services/ai-service";
import type { PlaceEntry } from "#/lib/services/place-service";
import { cn } from "#/lib/utils";
import { getLabelAnalysisPlan } from "#/server/ai";
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
export interface RescanSource {
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
}

export function PhotoRegisterWizard({
	places,
	route,
	rescan,
	active,
	onSwitchToManual,
}: PhotoRegisterWizardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [photos, setPhotos] = useState<PhotoItem[]>([]);
	// 再解析なら元バッチの場所・見かけた日を引き継ぐ(同じ機会の記録なので、
	// 選び直させる意味が無い)。写真の読み込みだけは非同期なので effect で入れる。
	const [placeChoice, setPlaceChoice] = useState<string>(
		rescan?.placeId ?? NO_PLACE,
	);
	const [newPlaceName, setNewPlaceName] = useState("");
	const [seenOn, setSeenOn] = useState(
		() => rescan?.seenOn ?? todayCalendarDate(),
	);
	// 保存済み写真の読み込み状態。再解析でないときは常に false / 空。
	const [loadingRescanPhotos, setLoadingRescanPhotos] = useState(!!rescan);
	const [cards, setCards] = useState<ImportCardState[] | null>(null);
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
	// 記録フォームへ切り替えても失うものは無いので、引き継げない旨を出さない。
	const defaultSeenOnRef = useRef(seenOn);

	// 解析を押す前に「この枚数でいくら要るか」を出す。押してから残高不足で弾かれると、
	// 写真を選び直す手間だけが無駄になる(サーバ側の予約 estimateWineListReserveTokens と
	// 同じ式を共有するので、見積を変えても表示だけ古くなることはない)。
	const requiredCredits = creditsForPhotos(route, photos.length);
	// null = 未ログイン・取得中・取得失敗。残高0と区別できないので不足判定には使わない
	const balance = useCreditBalanceValue();
	const insufficientCredits = balance !== null && balance < requiredCredits;
	// 枚数を減らせば足りるのか、最小構成でも足りないのかで案内が変わる
	const canFixByFewerPhotos =
		balance !== null && balance >= creditsForPhotos(route, 1);

	// 単一ワイン判定で自動実行するエチケット解析の見積。経路(標準/Luna/Claude)で消費が
	// 2桁変わるので、解析を押す前に額を出す(切り替え後に黙って消費させない #355)。
	const { data: labelPlan } = useQuery({
		queryKey: ["label-analysis-plan"],
		queryFn: () => getLabelAnalysisPlan(),
		staleTime: 5 * 60 * 1000,
	});
	const labelAnalysisCredits = labelPlan
		? costToCredits(
				estimateLabelReserveCharge(
					labelPlan.route,
					Math.max(1, Math.min(photos.length, MAX_HANDOFF_PHOTOS)),
				).microUsd,
			)
		: null;

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
				setPhotos(
					files.map((file) => ({
						localId: `p${newIdRef.current++}`,
						file,
						previewUrl: URL.createObjectURL(file),
					})),
				);
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
	 * 目撃記録側の入力(写真の場所・撮影日)をユーザが触ったか。記録フォームには
	 * これらの入力欄が無いので、触っていたときだけ「引き継がれない」と知らせる。
	 */
	const hasSightingInput = () =>
		placeChoice !== NO_PLACE || seenOn !== defaultSeenOnRef.current;

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
			setSummary(result.summary);
			setCards(buildImportCards(result.candidates));
			if (result.candidates.length === 0) {
				setError(
					"写真からワインを読み取れませんでした。ワインリストや棚が写るように撮り直してください。",
				);
				return;
			}
			// 1本のワインのエチケット等を撮った写真だった場合は、レビューではなく単体の
			// 記録フォームへ切り替える(#416)。レビュー画面は裏で組み立て済みなので、
			// 誤判定だった場合はフォームから戻ればそのまま一括登録を続けられる。
			const single = singleWineCandidate(result.candidates, result.summary);
			if (single) {
				onSwitchToManual(
					buildSingleWineHandoff(
						single,
						photos.map((p) => p.file),
						hasSightingInput(),
					),
				);
			}
		},
		onError: (e: Error) => setError(e.message || "写真の解析に失敗しました"),
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
						photoCount: photos.length,
					}),
				}));
			setRegistered(result);
			// 写真の実体は登録確定後(R2キーが batchId 依存)。ここで失敗しても記録は
			// 残っているので、**そのことが伝わる文言に置き換えてから** throw する
			// (onError 側で判定すると、この実行で setRegistered した結果がまだ
			// クロージャに反映されておらず、初回の失敗を「登録に失敗」と誤って出す)。
			try {
				await uploadImportBatchPhotos(
					result.batchId,
					photos.map((p) => p.file),
				);
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
			) : cards === null ? (
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
								解析し直すとAIクレジットを消費します。元の登録はそのまま残り、
								同じ銘柄と判定できたものは「既存に追加」として出ます。
								<strong className="font-medium">
									読み取り方が前回と変わった銘柄は新規として出る
								</strong>
								ので、重複させたくないものはチェックを外してください。不要になったら履歴から取り消せます。
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
							id="register-photo"
							type="file"
							accept={PHOTO_ACCEPT_ATTR}
							multiple
							onChange={handleFileChange}
							disabled={photos.length >= MAX_PHOTOS_PER_IMPORT_BATCH}
							className="max-w-xs"
						/>
						<p className="text-xs text-muted-foreground">
							ワインのエチケット(ラベル)や、レストランのワインリスト・ショップの棚を撮った写真を選んでください。
							{PHOTO_FORMATS_LABEL_JA}、各{MAX_PHOTO_SIZE_LABEL}まで。
							同じワインが複数の写真に写っていても1件にまとめます。
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
							<Button
								type="button"
								disabled={
									photos.length === 0 ||
									isAnalyzing ||
									loadingRescanPhotos ||
									insufficientCredits ||
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
							{/*
							  写真を使わずに全部自分で書きたい場合の逃げ道。選択済みの写真は
							  そのまま記録フォームへ添付するので、選び直しは要らない。
							*/}
							<Button
								type="button"
								variant="ghost"
								disabled={isAnalyzing}
								onClick={() =>
									onSwitchToManual({
										...takePhotosForEntry(photos.map((p) => p.file)),
										reason: "manual_choice",
										discardedSightingInput: hasSightingInput(),
									})
								}
							>
								<PencilIcon className="size-4" aria-hidden />
								手動で入力
							</Button>
						</div>
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
									解析には最大で数分かかります。完了するまで画面を閉じないでください。
								</p>
								{/*
								  単一ワインと判定したときは記録フォームへ自動で切り替わり、
								  そこでエチケット解析も自動実行する。追加のクレジットを使うので、
								  解析を押す前に額を知らせておく(#355)。
								*/}
								<p className="text-xs text-muted-foreground">
									1本のワインのエチケットだけが写っていた場合は、そのまま記録フォームに切り替えて、より詳しいエチケット解析を自動で実行します
									{labelAnalysisCredits !== null &&
										`(追加で約${labelAnalysisCredits.toLocaleString("ja-JP")}クレジットを消費)`}
									。
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
										setCards(null);
										setSummary(null);
										setError("");
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
