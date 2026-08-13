import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine, labelAnalysisJob, place } from "#/db/schema";
import type { WineListRoute } from "#/lib/ai/config";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import {
	DEFAULT_LABEL_JOB_KIND,
	isTerminalLabelJobStatus,
	LABEL_JOB_FAILED_ERROR_MESSAGE,
	LABEL_JOB_PHOTO_RETENTION_MS,
	LABEL_JOB_QUEUE_STALE_MS,
	LABEL_JOB_STALE_ERROR_MESSAGE,
	LABEL_JOB_STALE_MS,
	type LabelJobKind,
	type LabelJobStatus,
	MAX_CONCURRENT_LABEL_JOBS,
} from "#/lib/ai/label-job";
import {
	buildWinePhotoKey,
	MAX_PHOTOS_PER_ENTRY,
	resolveStoredPhotoMime,
} from "#/lib/drunk-wine/photo";
import {
	BadRequestError,
	NotFoundError,
	TooManyRequestsError,
} from "#/lib/errors";
import { imagePathForKey } from "#/lib/images/signed-url";
import { logError, logInfo, logWarn } from "#/lib/logger";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import {
	type LabelPlan,
	resolveLabelPlan,
	resolveWineListPlan,
	restoreLabelPlan,
	restoreWineListPlan,
	runLabelAnalysisForJob,
	runWineListAnalysisForJob,
	type WineListAnalysisOutcome,
	type WineListPlan,
} from "#/lib/services/ai-service";
import * as creditService from "#/lib/services/credit-service";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import {
	abandonMeteredInference,
	beginMeteredInference,
	type MeteredInferenceReservation,
} from "#/lib/services/metered-inference";
import { sendPushToUser } from "#/lib/services/push-service";

// エチケット解析ジョブのサービス層(Issue #460)。
//
// 「投入したらページを離れてよく、後から完了が分かる」を成り立たせるための状態遷移を
// ここに閉じ込める。守るべき不変条件は3つで、どれも過去に壊れて実害を出した類型に属する:
//
//  1. **ジョブ行が存在する = 予約が成立している**。残高不足は行を作らず投入APIがその場で
//     返す。行を作ってから予約すると「予約の無いジョブ」が推論を走らせてしまう
//  2. **未終端のジョブは必ず終端に到達する**。コンシューマは予告なく死ぬので、次に来た
//     投入・状態取得が `LABEL_JOB_STALE_MS` を過ぎた `running` を決着させる。
//     決着させないと UI が永久にポーリングし、同時実行の枠も空かない
//  3. **クレジットの回収機構をここに作らない**。予約が宙に浮いた場合の回収は
//     credit-service の `reclaimOrphanReservations` が次の予約時に拾う(#246)。
//     ここで別の回収を書くと二重回収になる(詳細は settleStale… のコメント)

/** 投入する写真1枚。実バイトと申告MIMEを受け取り、保存時のMIMEは実バイトから確定する。 */
export interface LabelJobPhotoInput {
	bytes: Uint8Array;
	/** クライアントの申告値。検証には使うが保存する Content-Type はここから採らない(#150) */
	mimeType: string;
}

export type SubmitLabelAnalysisJobResult =
	/** 残高不足。ジョブ行は作られていない(予約が成立していないので当然) */
	| { blocked: true; balance: number; required: number }
	| { blocked: false; jobId: string; status: LabelJobStatus };

/** 状態取得APIが返す形。`suggestions` は succeeded のときだけ入る。 */
export interface LabelAnalysisJobView {
	jobId: string;
	status: LabelJobStatus;
	photoCount: number;
	/** 実際に走る(走った)経路。UI が「高精度で解析中」等を出すのに使う */
	route: string;
	suggestions?: LabelSuggestions;
	actualTokens?: number;
	/** 失敗時の利用者向け文言 */
	error?: string;
	/**
	 * 終端に到達した回だけ載る現在残高。同期経路(`analyzeWineLabel`)が応答に `balance` を
	 * 返すのに合わせ、UI が完了時に残高表示を更新できるようにする。**ポーリングのたびに
	 * 引かない**のは、`getBalance` が月次付与の遅延実行(書き込み)を伴うため。
	 */
	balance?: number;
	createdAt: number;
	finishedAt?: number;
	/** 利用者が結果を受け取ったか(#462)。完了バッジの出し分けに使う */
	consumed?: boolean;
	/**
	 * この結果が宛てられている既存エントリ(#472)。受け取り導線がここを見て
	 * 「新規登録」と「そのワインを編集」を振り分ける。
	 */
	entryId?: string;
	/**
	 * 解析の種別(#474)。受け取り導線がここを見て行き先を決める——`label` なら記録
	 * フォーム、`wine_list` なら一括登録のレビュー画面。
	 */
	kind: LabelJobKind;
	/** 一括抽出の結果。`kind === "wine_list"` の成功時だけ入る(#474)。 */
	wineList?: WineListAnalysisOutcome;
	/**
	 * 投入時に入力された「どこで・いつ撮ったか」(#498)。受け取り画面が目撃記録の
	 * 初期値に使う。何も入力されていなかった回は未指定。
	 */
	sighting?: LabelJobSighting;
	/**
	 * 解析に使った写真の表示URL(撮影順)。**引き継ぎ前の成功ジョブだけ入る**——
	 * 記録の確定で `adoptLabelJobPhotos` がエントリへ渡すと空になる(#474)。
	 *
	 * 受け取り画面が「この写真ごと保存される」ことを見せるために要る(#498)。
	 * 手元に `File` が無いので**フォームの写真UIでは扱えない**(削除・並べ替えは
	 * エントリの写真集合に対する操作で、まだこのワインのキーではない)。読み取り専用の
	 * プレビューとして出す。
	 */
	photoUrls?: string[];
}

/**
 * 投入時に写真ウィザードで入力された目撃記録の文脈(#498)。
 *
 * `placeId`(既存の場所)と `newPlaceName`(その場で作る場所の名前)は排他。後者で
 * place 行を作らないのは、記録せずに離脱した回のぶんだけ空の場所が増えるため。
 */
export interface LabelJobSighting {
	placeId?: string;
	newPlaceName?: string;
	seenOn?: string;
}

/** 未終端(= まだ枠を占有している)状態。 */
const ACTIVE_STATUSES = ["queued", "running"] as const;

/**
 * マイセラーの解析バッジの材料(#462)。
 *
 * **件数だけでなく最新の1件のIDを返す**。バッジの主導線は「完了をタップして候補入りの
 * 登録フォームを開く」なので、UI 側がもう1往復して一覧を引き直さずに遷移できる形にする。
 */
export interface LabelAnalysisJobBadge {
	/** 未終端(queued/running)の件数 */
	activeCount: number;
	/** 完了していて、まだ受け取られていない件数 */
	readyCount: number;
	/** 受け取り待ちのうち最も古いジョブのID。`readyCount === 0` なら undefined */
	nextReadyJobId?: string;
}

/**
 * エチケット解析ジョブを投入する。
 *
 * 順序に意味がある:
 *
 *   1. 入力検証 → 2. stale の決着 → 3. 同時実行数の確認 → 4. plan の解決(D1読み+env)
 *   → 5. **予約** → 6. R2 保存 → 7. 行作成 → 8. enqueue
 *
 * D1 読みと env 解決を予約より前に済ませるのは #245 の順序制約そのもの。予約(5)より後の
 * 失敗は、すべて `abandonMeteredInference` で返却してから throw する——ここを漏らすと
 * 「写真の保存に失敗しただけでクレジットが消える」ことになる。
 */
export async function submitLabelAnalysisJob(
	userId: string,
	photos: LabelJobPhotoInput[],
	/** 解析の種別(#474)。既定はエチケット解析(1本)。 */
	kind: LabelJobKind = DEFAULT_LABEL_JOB_KIND,
	/**
	 * 投入時に入力された「どこで・いつ撮ったか」(#498)。完了を待たずに離脱した回の
	 * 受け取りで、記録フォームの目撃記録へ復元する。
	 */
	sighting?: LabelJobSighting,
): Promise<SubmitLabelAnalysisJobResult> {
	if (photos.length === 0) {
		throw new BadRequestError("画像が指定されていません");
	}
	// **枚数の上限は種別で違う**。エチケット解析は1本ぶんの写真(表・裏など)で
	// エントリの上限に揃え、一括抽出はリストや棚を分割して撮るぶん多く受ける。
	const maxPhotos =
		kind === "wine_list" ? MAX_PHOTOS_PER_IMPORT_BATCH : MAX_PHOTOS_PER_ENTRY;
	if (photos.length > maxPhotos) {
		throw new BadRequestError(`写真は最大${maxPhotos}枚までです`);
	}
	// 保存する Content-Type は申告値ではなく実バイト(マジックバイト)から確定する。
	// 中身がHTML/スクリプト等の画像偽装や、申告と実フォーマットの食い違いを拒否する(#150)。
	// **経路ごとに書かず共通の関門を通す**(#174 でワイン写真経路への適用漏れが起きた)。
	const resolved: { bytes: Uint8Array; mime: string }[] = [];
	for (const photo of photos) {
		const mime = resolveStoredPhotoMime(photo.bytes, photo.mimeType);
		if (!mime) {
			throw new BadRequestError(
				"画像として認識できないか、形式が申告値と一致しないファイルが含まれています",
			);
		}
		resolved.push({ bytes: photo.bytes, mime });
	}

	// 場所の所有権は**予約より前**に確認する(#245 の順序制約。ここで弾くぶんには
	// クレジットが動いていない)。他人の場所・存在しないIDは区別せず 404。
	if (sighting?.placeId) {
		const [row] = await db
			.select({ id: place.id })
			.from(place)
			.where(and(eq(place.id, sighting.placeId), eq(place.userId, userId)));
		if (!row) throw new NotFoundError("Place not found");
	}

	// 死んだコンシューマの残骸が枠を埋めたままにならないよう、数える前に決着させる。
	await settleStaleLabelAnalysisJobs(userId);
	// 引き取り手が現れなかった写真もここで回収する(#474)。**投入のときだけ**にするのは、
	// 状態取得やバッジは解析中3秒ごとに走るため——回収は急がないので、頻度の低い経路に
	// 相乗りさせる。
	await sweepConsumedJobPhotos(userId);
	const active = await countActiveLabelAnalysisJobs(userId);
	if (active >= MAX_CONCURRENT_LABEL_JOBS) {
		// 予約は投入時に立つので、連投されると残高が予約で埋まり本人の他のAI機能まで
		// ブロックされる。同期経路の「1リクエスト = 1解析」に相当する上限をここで課す。
		throw new TooManyRequestsError(
			`解析中のジョブが${MAX_CONCURRENT_LABEL_JOBS}件あります。完了してからもう一度お試しください。`,
		);
	}

	// D1読み・env解決は**予約より前**(#245)。
	const plan =
		kind === "wine_list"
			? await resolveWineListPlan(userId, photos.length)
			: await resolveLabelPlan(userId, photos.length);
	const begun = await beginMeteredInference(userId, {
		estimate: plan.estimate,
		requestId: plan.requestId,
		logBase: plan.logBase,
	});
	if (begun.blocked) {
		return { blocked: true, balance: begun.balance, required: begun.required };
	}
	const { reservation } = begun;

	// ここから先の失敗は必ず返却して閉じる。
	const jobId = crypto.randomUUID();
	const putKeys: string[] = [];
	try {
		for (const photo of resolved) {
			// キーはマイセラー写真と同じ接頭辞に載せる(`wines/{userId}/{jobId}/…`)。
			// 非公開画像の認可・署名URL・退会時の一括削除がこのレイアウトを前提に
			// 書かれており、専用接頭辞の新設は4箇所の同時拡張を要求する。
			const key = buildWinePhotoKey(
				userId,
				jobId,
				crypto.randomUUID(),
				photo.mime,
			);
			await env.AVATARS.put(key, photo.bytes, {
				httpMetadata: { contentType: photo.mime },
			});
			putKeys.push(key);
		}
		await db.insert(labelAnalysisJob).values({
			id: jobId,
			userId,
			status: "queued",
			photoKeys: putKeys,
			photoCount: photos.length,
			requestId: reservation.requestId,
			reservedCredits: reservation.reservedCredits,
			reservedMicroUsd: reservation.reservedMicroUsd,
			// 一括抽出は経路のフォールバックを持たない(#358)ので、選択 = 実行経路。
			selectedEngine: "engine" in plan ? plan.engine : plan.route,
			route: plan.route,
			kind,
			// 「どこで・いつ撮ったか」(#498)。既存の場所と新規の名前は排他で、
			// 排他はウィザードの選択が保証する(片方しか選べない)。
			placeId: sighting?.placeId ?? null,
			newPlaceName: sighting?.placeId ? null : (sighting?.newPlaceName ?? null),
			seenOn: sighting?.seenOn ?? null,
		});
		// **行を作ってから enqueue する**。逆にするとコンシューマが行の無いジョブIDを
		// 受け取りうる(キューは配信が速い)。行があって未配信なら stale で決着できるが、
		// 行が無いメッセージは何も手掛かりが残らない。
		await env.LABEL_JOBS.send({ jobId });
	} catch (e) {
		// 予約を返却してから、写真とジョブ行の残骸を掃除する。掃除の失敗で真因を隠さない
		// よう、元例外は必ず再 throw する。
		await abandonMeteredInference(
			userId,
			{ reservation, logBase: plan.logBase },
			e,
		);
		await deletePhotoObjects(putKeys, {
			userId,
			jobId,
			phase: "submit-rollback",
		});
		try {
			await db.delete(labelAnalysisJob).where(eq(labelAnalysisJob.id, jobId));
		} catch (cleanupErr) {
			// 掃除の失敗で真因を隠さない。行が残っても未終端なので stale が決着させる。
			logError("failed to clean up label analysis job row", {
				userId,
				jobId,
				err: cleanupErr,
			});
		}
		throw e;
	}
	logInfo("label analysis job queued", {
		userId,
		jobId,
		requestId: reservation.requestId,
		route: plan.route,
		photoCount: photos.length,
	});
	return { blocked: false, jobId, status: "queued" };
}

/**
 * ジョブを1件実行する(キュー・コンシューマの本体)。
 *
 * **キューは at-least-once** なので同じ jobId が2回届きうる。`queued → running` の遷移を
 * 条件付き UPDATE の RETURNING で行い、行が返らなければ「他が既に掴んだ / 既に終わっている」
 * として何もせずに返す。これが二重実行(= 二重課金)を防ぐ唯一の関門。
 *
 * 例外を投げない: 投げるとキューが再配信するが、claim ガードにより再配信は必ず空振りする
 * (= リトライしても直らない)。失敗はジョブ行に記録して ack する。
 */
export async function runLabelAnalysisJob(jobId: string): Promise<void> {
	const startedAt = Date.now();
	// claim: queued の間だけ running へ動かす。**メッセージの中身は信用せず常に最新行を
	// 読む**(再配信で古い内容が復活しないように、メッセージには jobId しか載せていない)。
	const [job] = await db
		.update(labelAnalysisJob)
		.set({ status: "running", startedAt: new Date(startedAt) })
		.where(
			and(
				eq(labelAnalysisJob.id, jobId),
				eq(labelAnalysisJob.status, "queued"),
			),
		)
		.returning();
	if (!job) {
		// 再配信・stale 決着後の到着など。実行しないのが正しい。
		logInfo("label analysis job not claimable; skipping", { jobId });
		return;
	}

	// **経路は再解決しない**(投入時の見積で予約が立っているため)。種別で復元先が違う。
	const isWineList = job.kind === "wine_list";
	const plan = isWineList
		? restoreWineListPlan({
				route: job.route as WineListRoute,
				photoCount: job.photoCount,
				requestId: job.requestId,
			})
		: restoreLabelPlan({
				engine: job.selectedEngine,
				route: job.route,
				photoCount: job.photoCount,
				requestId: job.requestId,
			});
	const reservation: MeteredInferenceReservation = {
		requestId: job.requestId,
		reservedCredits: job.reservedCredits,
		reservedMicroUsd: job.reservedMicroUsd,
	};

	let imageDataUrls: string[];
	try {
		imageDataUrls = await loadPhotoDataUrls(job.photoKeys);
	} catch (e) {
		// 写真が読めない = 推論に到達できない。予約を返却して失敗で終端させる
		// (`finishMeteredInference` の catch と同じ組み立てを abandon が担う)。
		await abandonMeteredInference(
			job.userId,
			{ reservation, logBase: plan.logBase, startedAt },
			e,
		);
		logError("label analysis job photos unreadable", {
			userId: job.userId,
			jobId,
			err: e,
		});
		await finishJob(
			jobId,
			{ error: LABEL_JOB_FAILED_ERROR_MESSAGE },
			job.photoKeys,
		);
		return;
	}

	try {
		// 種別で違うのは**推論の中身と結果の置き場だけ**。予約の確定・失敗時返却も、
		// ジョブ行の終端化も、この後は共通の経路を通る。
		if (isWineList) {
			const done = await runWineListAnalysisForJob(job.userId, {
				imageDataUrls,
				plan: plan as WineListPlan,
				reservation,
				startedAt,
			});
			await finishJob(
				jobId,
				{ wineList: done.value, actualTokens: done.charge.tokens },
				job.photoKeys,
			);
		} else {
			const done = await runLabelAnalysisForJob(job.userId, {
				imageDataUrls,
				plan: plan as LabelPlan,
				reservation,
				startedAt,
			});
			await finishJob(
				jobId,
				{ suggestions: done.value, actualTokens: done.charge.tokens },
				job.photoKeys,
			);
		}
	} catch (e) {
		// 予約の返却と failed の実行記録は runLabelAnalysisForJob(finishMeteredInference)が
		// 済ませている。ここでやるのはジョブ行の終端化だけ。
		// 詳細はAIモデル都合のことが多く利用者に出しても行動できないため、行には固定文言を
		// 置き、文脈付きの記録はサーバ側に残す(同期経路の /api/label-analysis と同じ規約 #156)。
		logError("label analysis job failed", {
			userId: job.userId,
			jobId,
			requestId: job.requestId,
			err: e,
		});
		await finishJob(
			jobId,
			{ error: LABEL_JOB_FAILED_ERROR_MESSAGE },
			job.photoKeys,
		);
	}
}

/**
 * ジョブの状態を返す(本人のもののみ)。ポーリングの入口なので、ついでに stale の決着も
 * 行う——**投入が来ないと決着しない**状態にすると、1件だけ投げて離席したユーザのジョブが
 * 永久に `running` のまま残り、UI がポーリングを止められない。
 */
export async function getLabelAnalysisJob(
	userId: string,
	jobId: string,
): Promise<LabelAnalysisJobView> {
	await settleStaleLabelAnalysisJobs(userId);
	const [job] = await db
		.select()
		.from(labelAnalysisJob)
		.where(
			and(eq(labelAnalysisJob.id, jobId), eq(labelAnalysisJob.userId, userId)),
		)
		.limit(1);
	// 所有権チェックは WHERE id AND user_id(JOIN 無し)の規約。他人のジョブは
	// 「存在しない」として扱い、IDの存在有無を漏らさない。
	if (!job) throw new NotFoundError("ジョブが見つかりません");
	const view = toJobView(job);
	if (!isTerminalLabelJobStatus(view.status)) return view;
	const { balance } = await creditService.getBalance(userId);
	return { ...view, balance };
}

/**
 * 本人の「まだ画面に出すべき」ジョブを新しい順に返す。
 *
 * 対象は **未終端(queued/running) + 完了していて未受け取り(succeeded かつ consumed_at
 * が null)**。失敗したジョブは含めない——失敗は投入した画面でその場で見せるもので、
 * 後からマイセラーに溜めても利用者が取れる行動が無い(クレジットは返却済み)。
 *
 * 件数は同時実行上限で頭打ちなので上限指定は要らない。
 */
export async function listPendingLabelAnalysisJobs(
	userId: string,
): Promise<LabelAnalysisJobView[]> {
	await settleStaleLabelAnalysisJobs(userId);
	const rows = await db
		.select()
		.from(labelAnalysisJob)
		.where(and(eq(labelAnalysisJob.userId, userId), pendingCondition()))
		.orderBy(desc(labelAnalysisJob.createdAt));
	return rows.map(toJobView);
}

/**
 * 未終端、または完了していて未受け取りのジョブを指す条件(#462)。
 *
 * **一覧・バッジ・受け取りで同じ条件を使う**ため関数に切り出す。ここが経路ごとに
 * 書き分けられると、「バッジには出るのに開くと空」「受け取ったのにバッジが減らない」が
 * 静かに生まれる(CLAUDE.md の「同種の定義が2箇所以上に現れたらSSOT化する」)。
 */
function pendingCondition() {
	return or(
		inArray(labelAnalysisJob.status, [...ACTIVE_STATUSES]),
		and(
			eq(labelAnalysisJob.status, "succeeded"),
			isNull(labelAnalysisJob.consumedAt),
		),
	);
}

/**
 * マイセラーの解析バッジの材料を返す(#462)。
 *
 * 一覧(`listPendingLabelAnalysisJobs`)と**同じ条件**を通し、件数だけを取り出す。
 * バッジは全ページの共通ヘッダから引かれうるので、行の中身(suggestions は数KBある)を
 * 運ばない形にしてある。
 */
export async function getLabelAnalysisJobBadge(
	userId: string,
): Promise<LabelAnalysisJobBadge> {
	await settleStaleLabelAnalysisJobs(userId);
	const rows = await db
		.select({
			id: labelAnalysisJob.id,
			status: labelAnalysisJob.status,
			createdAt: labelAnalysisJob.createdAt,
		})
		.from(labelAnalysisJob)
		.where(and(eq(labelAnalysisJob.userId, userId), pendingCondition()))
		.orderBy(asc(labelAnalysisJob.createdAt));
	const ready = rows.filter((row) => row.status === "succeeded");
	return {
		activeCount: rows.length - ready.length,
		readyCount: ready.length,
		// 受け取り待ちは**古い順に**案内する(投げた順に片付く)。
		...(ready[0] ? { nextReadyJobId: ready[0].id } : {}),
	};
}

/**
 * 完了したジョブを受け取り済みにして、その候補を返す(#462)。
 *
 * 「候補入りの登録フォームを開く」導線の入口。**取得と既読化を1つの操作にする**のは、
 * 別々にすると「開いたのにバッジが減らない」「減ったのに候補が出ない」の両方が起きうる
 * ため。既読化は条件付き UPDATE の RETURNING で行い、二重に開いても2回目は
 * `alreadyConsumed` を返す(候補自体は返すので、リロードで空になったりはしない)。
 */
export async function consumeLabelAnalysisJob(
	userId: string,
	jobId: string,
): Promise<{ view: LabelAnalysisJobView; alreadyConsumed: boolean }> {
	const [job] = await db
		.select()
		.from(labelAnalysisJob)
		.where(
			and(eq(labelAnalysisJob.id, jobId), eq(labelAnalysisJob.userId, userId)),
		)
		.limit(1);
	if (!job) throw new NotFoundError("ジョブが見つかりません");
	if (job.status !== "succeeded") {
		// まだ終わっていない/失敗したジョブには受け取る候補が無い。ポーリングの
		// 状態取得(getLabelAnalysisJob)を使うべき場面なので、その旨を返す。
		throw new BadRequestError("このジョブにはまだ解析結果がありません");
	}
	const [updated] = await db
		.update(labelAnalysisJob)
		.set({ consumedAt: new Date() })
		.where(
			and(
				eq(labelAnalysisJob.id, jobId),
				eq(labelAnalysisJob.userId, userId),
				isNull(labelAnalysisJob.consumedAt),
			),
		)
		.returning({ id: labelAnalysisJob.id });
	return { view: toJobView(job), alreadyConsumed: !updated };
}

/**
 * 解析結果の宛先エントリを記録する(#472)。
 *
 * 解析中に記録フォームを保存して離脱すると、完了の受け取り(`/cellar/new?labelJob=…`)が
 * 新規作成モードで開き、**同じワインが2件登録される**。保存した時点でその宛先をジョブに
 * 残しておけば、受け取りを「そのワインを編集」へ振り分けられる。
 *
 * **最初に宛てられたエントリが勝つ**(`entry_id IS NULL` の条件付き UPDATE)。同じジョブの
 * 結果を2つのエントリへ記録できてしまうと、後から開いたときにどちらを直せばよいか決まらない。
 * 2回目以降は `attached: false` を返すだけで、呼び出し側の保存は妨げない。
 *
 * 終端・受け取り済みのジョブにも紐づける。走行中に保存した回だけでなく、完了を見てから
 * 保存した回も「この結果はもう記録済み」であることに変わりはなく、URLを開き直したときの
 * 重複を同じ仕組みで塞げる。
 */
export async function attachLabelAnalysisJobEntry(
	userId: string,
	jobId: string,
	entryId: string,
): Promise<{ attached: boolean; adoptedPhotos: number }> {
	// 宛先が本人のエントリであることを確かめる。**他人のエントリIDを宛先にできると**、
	// 受け取り導線がそのIDへ遷移し、存在の有無を漏らす経路になる(所有権チェックは
	// WHERE id AND user_id の規約 #177)。
	const [entry] = await db
		.select({ id: drunkWine.id })
		.from(drunkWine)
		.where(and(eq(drunkWine.id, entryId), eq(drunkWine.userId, userId)))
		.limit(1);
	if (!entry) throw new NotFoundError("ワインが見つかりません");

	const [updated] = await db
		.update(labelAnalysisJob)
		.set({ entryId })
		.where(
			and(
				eq(labelAnalysisJob.id, jobId),
				eq(labelAnalysisJob.userId, userId),
				isNull(labelAnalysisJob.entryId),
			),
		)
		.returning({ id: labelAnalysisJob.id });
	if (updated) {
		logInfo("label analysis job attached to entry", { userId, jobId, entryId });
	}
	// **記録できた = 解析に使った写真の行き先が決まった**(#474)。ここを引き継ぎの契機に
	// するのは、保存の成否と一致する唯一の点だから——受け取って表示しただけの回に足すと、
	// 記録せずに離脱した利用者のワインに写真だけが増える。
	//
	// まだ走っているジョブでは何もしない(`adoptLabelJobPhotos` が succeeded を要求する)。
	// その回は完了後の受け取りで改めてここを通る。
	const { adopted } = await adoptLabelJobPhotos(userId, jobId, entryId);
	return { attached: !!updated, adoptedPhotos: adopted };
}

/**
 * 解析に使った写真を、その結果を記録したワインの写真として引き継ぐ(#474)。
 *
 * 利用者が撮ったのはそのワインの写真であって、解析のためだけの使い捨てではない。
 * 従来は終端で消していたため、受け取り画面には「写真は解析用のもので保存されていない
 * ため、残す場合は選び直してください」と出して撮り直させていた。
 *
 * **バイト列はコピーしない**。R2キーの所有と掃除は `wines/{userId}/…` の userId までしか
 * 見ていないので、キーをエントリの写真集合へ移すだけで所有が移る(詳細は
 * `appendDrunkWinePhotoKeys`)。
 *
 * 順序に意味がある: **エントリへ足してからジョブの所有を外す**。逆にすると、間で失敗した
 * ときに「どこからも参照されない写真」が残る。エントリ側が先なら、最悪ジョブとエントリの
 * 両方が同じキーを指すだけで、実体は生きている(次の引き継ぎは重複を足さない)。
 *
 * 冪等。写真を持たないジョブ・既に引き継ぎ済みのジョブは何もせず返す。
 */
export async function adoptLabelJobPhotos(
	userId: string,
	jobId: string,
	entryId: string,
): Promise<{ adopted: number }> {
	const [job] = await db
		.select()
		.from(labelAnalysisJob)
		.where(
			and(eq(labelAnalysisJob.id, jobId), eq(labelAnalysisJob.userId, userId)),
		)
		.limit(1);
	// **他人のジョブ・存在しないIDは黙って何もしない**。呼び出し元(`attachLabelAnalysisJobEntry`)
	// はそれらを条件付き UPDATE の空振りとして扱い、IDの存在有無を漏らさない設計なので、
	// ここだけ 404 を投げると同じ入力で挙動が割れる(存在するジョブだけが例外になる = 漏れる)。
	if (!job) return { adopted: 0 };
	if (job.status !== "succeeded" || job.photoKeys.length === 0) {
		return { adopted: 0 };
	}

	const { adopted, dropped } = await drunkWineService.appendDrunkWinePhotoKeys(
		userId,
		entryId,
		job.photoKeys,
	);

	// 所有を手放す。**エントリが取らなかったぶん(上限超過)はここで消す**——ジョブから
	// 外した後は誰も参照しないため。
	await db
		.update(labelAnalysisJob)
		.set({ photoKeys: [] })
		.where(
			and(eq(labelAnalysisJob.id, jobId), eq(labelAnalysisJob.userId, userId)),
		);
	await deletePhotoObjects(dropped, { userId, jobId, phase: "adopt-overflow" });

	logInfo("label analysis job photos adopted", {
		userId,
		jobId,
		entryId,
		adopted: adopted.length,
		dropped: dropped.length,
	});
	return { adopted: adopted.length };
}

/**
 * 一括抽出に使った写真を、その結果から作った一括登録バッチへ引き継ぐ(#474)。
 *
 * エントリ向けの `adoptLabelJobPhotos` と同じ形。ジョブ化でレビュー画面へ戻ってきた
 * 利用者の手元に `File` が無いため、アップロードし直させずサーバ側で渡す。
 */
export async function adoptLabelJobPhotosToBatch(
	userId: string,
	jobId: string,
	batchId: string,
): Promise<{ adopted: number }> {
	const [job] = await db
		.select()
		.from(labelAnalysisJob)
		.where(
			and(eq(labelAnalysisJob.id, jobId), eq(labelAnalysisJob.userId, userId)),
		)
		.limit(1);
	// 他人のジョブ・存在しないIDは黙って何もしない(adoptLabelJobPhotos と同じ理由)。
	if (!job) return { adopted: 0 };
	if (job.status !== "succeeded" || job.photoKeys.length === 0) {
		return { adopted: 0 };
	}

	const { adopted, dropped } = await drunkWineService.adoptImportBatchPhotoKeys(
		userId,
		batchId,
		job.photoKeys,
	);
	// エントリ側と同じ順序: 宛先へ渡してから所有を外す。
	await db
		.update(labelAnalysisJob)
		.set({ photoKeys: [] })
		.where(
			and(eq(labelAnalysisJob.id, jobId), eq(labelAnalysisJob.userId, userId)),
		);
	await deletePhotoObjects(dropped, { userId, jobId, phase: "adopt-overflow" });
	logInfo("label analysis job photos adopted by batch", {
		userId,
		jobId,
		batchId,
		adopted: adopted.length,
	});
	return { adopted: adopted.length };
}

/**
 * 引き継がれないまま受け取り済みになったジョブの写真を回収する(#474)。
 *
 * 成功した回の写真を終端で消さなくなったぶん、**引き取り手が現れなかった回の逃げ道**が
 * 要る。受け取り済み(`consumed_at`)= 利用者は結果を画面で見た、の意なので、そこから
 * `LABEL_JOB_PHOTO_RETENTION_MS` 経っても引き継がれていなければ、記録には使われなかった
 * と判断してよい。
 *
 * 呼ぶのは投入・状態取得と同じ「次に来た誰かが片付ける」流儀(`settleStaleLabelAnalysisJobs`
 * と同じ理由: 定期実行の口を新設せずに済む)。
 */
export async function sweepConsumedJobPhotos(userId: string): Promise<number> {
	const cutoff = new Date(Date.now() - LABEL_JOB_PHOTO_RETENTION_MS);
	const rows = await db
		.select({ id: labelAnalysisJob.id, photoKeys: labelAnalysisJob.photoKeys })
		.from(labelAnalysisJob)
		.where(
			and(
				eq(labelAnalysisJob.userId, userId),
				eq(labelAnalysisJob.status, "succeeded"),
				isNull(labelAnalysisJob.entryId),
				lt(labelAnalysisJob.consumedAt, cutoff),
			),
		);
	let swept = 0;
	for (const row of rows) {
		if (row.photoKeys.length === 0) continue;
		// 先に所有を外してから消す。逆順だと、消した後に更新が失敗した回で
		// 「行はキーを指しているのに実体が無い」状態になり、引き継ぎが壊れた写真を渡す。
		await db
			.update(labelAnalysisJob)
			.set({ photoKeys: [] })
			.where(eq(labelAnalysisJob.id, row.id));
		await deletePhotoObjects(row.photoKeys, {
			userId,
			jobId: row.id,
			phase: "retention",
		});
		swept += 1;
	}
	return swept;
}

/** 未終端(queued/running)のジョブ件数。同時実行上限の判定に使う。 */
async function countActiveLabelAnalysisJobs(userId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(labelAnalysisJob)
		.where(
			and(
				eq(labelAnalysisJob.userId, userId),
				inArray(labelAnalysisJob.status, [...ACTIVE_STATUSES]),
			),
		);
	return row?.count ?? 0;
}

/**
 * 放置された未終端ジョブを失敗として決着させる。
 *
 * コンシューマは予告なく死ぬ(コンテナ回収・デプロイ・ランタイムの打ち切り)。決着させ
 * ないと UI が永久にポーリングし、`MAX_CONCURRENT_LABEL_JOBS` の枠も空かない。
 *
 * **クレジットは返却しない**。ここで返すと `reclaimOrphanReservations`(#246)と二重に
 * 回収する経路ができる——あちらは「settle も refund もされていない予約」を次の予約時に
 * 拾う仕組みで、まさにこのケースを対象にしている。回収の責務は1箇所に残し、ここは
 * ジョブ行の決着(と写真の掃除)だけを行う。
 *
 * `queued` と `running` でしきい値を分けるのは待つ対象が違うため。`queued` はキューの
 * 配信・リトライを待っており(通常は数秒で `running` になる)、`running` は推論そのものを
 * 待っている。短すぎるしきい値は**生きているジョブを失敗にして**しまう(そのジョブは
 * この後 succeeded を書こうとするが、`finishJob` の未終端ガードに弾かれる)。
 */
export async function settleStaleLabelAnalysisJobs(
	userId: string,
): Promise<number> {
	const now = Date.now();
	const stale = await db
		.select()
		.from(labelAnalysisJob)
		.where(
			and(
				eq(labelAnalysisJob.userId, userId),
				or(
					and(
						eq(labelAnalysisJob.status, "running"),
						lt(labelAnalysisJob.startedAt, new Date(now - LABEL_JOB_STALE_MS)),
					),
					and(
						eq(labelAnalysisJob.status, "queued"),
						lt(
							labelAnalysisJob.createdAt,
							new Date(now - LABEL_JOB_QUEUE_STALE_MS),
						),
					),
				),
			),
		);
	if (stale.length === 0) return 0;

	let settled = 0;
	for (const job of stale) {
		const [row] = await db
			.update(labelAnalysisJob)
			.set({
				status: "failed",
				error: LABEL_JOB_STALE_ERROR_MESSAGE,
				finishedAt: new Date(),
				photoKeys: [],
			})
			.where(
				and(
					eq(labelAnalysisJob.id, job.id),
					inArray(labelAnalysisJob.status, [...ACTIVE_STATUSES]),
				),
			)
			.returning({ id: labelAnalysisJob.id });
		// 走査から UPDATE の間にコンシューマが終端まで進めていたら何もしない。
		if (!row) continue;
		settled += 1;
		logWarn("label analysis job settled as stale", {
			userId,
			jobId: job.id,
			requestId: job.requestId,
			status: job.status,
			startedAt: job.startedAt?.getTime(),
			createdAt: job.createdAt.getTime(),
		});
		await deletePhotoObjects(job.photoKeys, {
			userId,
			jobId: job.id,
			phase: "stale",
		});
	}
	return settled;
}

/**
 * ジョブを終端へ移す。**未終端の間だけ**書き込む条件を付けるのは、stale 決着で failed に
 * された後に生き延びていたコンシューマが succeeded を上書きするのを防ぐため
 * (「失敗した」と表示した後に結果が現れるより、失敗のまま見せるほうが一貫する。
 * クレジットは既に返却済みなので、上書きを許すと返却済みの結果を渡すことにもなる)。
 *
 * **成功した回の写真は残す**(#474)。解析の入力であると同時に、その結果を記録する
 * ワインの写真になる——利用者が撮ったのはそのワインの写真であって、解析のためだけの
 * 使い捨てではない。引き継ぎ(`adoptLabelJobPhotos`)がエントリへ渡した時点でジョブは
 * 所有を手放し、引き継がれないまま受け取り済みになった回は `sweepConsumedJobPhotos`
 * が回収する。**失敗した回は残さない**: 記録する結果が無いので、渡す先が無い。
 */
async function finishJob(
	jobId: string,
	outcome:
		| { suggestions: LabelSuggestions; actualTokens: number }
		| { wineList: WineListAnalysisOutcome; actualTokens: number }
		| { error: string },
	photoKeys: string[],
): Promise<void> {
	const failed = "error" in outcome;
	const [row] = await db
		.update(labelAnalysisJob)
		.set({
			...(failed
				? { status: "failed" as const, error: outcome.error }
				: {
						status: "succeeded" as const,
						// 結果の置き場は種別で分ける(同じ列に両方入れると読む側が毎回
						// 種別で分岐しながら unknown を絞ることになる)。
						...("wineList" in outcome
							? { wineListResult: outcome.wineList }
							: { suggestions: outcome.suggestions }),
						actualTokens: outcome.actualTokens,
					}),
			finishedAt: new Date(),
			// 成功した回は引き継ぎ先が決まるまで持ち続ける。
			...(failed ? { photoKeys: [] } : {}),
		})
		.where(
			and(
				eq(labelAnalysisJob.id, jobId),
				inArray(labelAnalysisJob.status, [...ACTIVE_STATUSES]),
			),
		)
		.returning({ id: labelAnalysisJob.id, userId: labelAnalysisJob.userId });
	if (!row) {
		logWarn("label analysis job already terminal; result discarded", { jobId });
	}
	// 行の更新に負けた回は、この実行が掴んでいた写真を置き去りにしない。勝った成功回は
	// 引き継ぎのために残す。
	if (failed || !row) {
		await deletePhotoObjects(photoKeys, { jobId, phase: "finish" });
	}

	// 完了通知(#466)。**この行の更新に勝ったときだけ**送る——負けた回は stale 決着で
	// 既に失敗として見せているので、そこへ「完了しました」を送ると表示と食い違う。
	// 失敗した回は送らない: 利用者が取れる行動が無く(クレジットは返却済み)、
	// 「失敗しました」の通知はロック画面に出るだけの雑音になる。
	//
	// **送信は throw しない**(push-service が内部で握る)。通知は付随物で、
	// 届かないことより届かないせいで終端化が巻き戻るほうが悪い。
	if (row && !("error" in outcome)) {
		await sendPushToUser(row.userId);
	}
}

/** R2 からジョブの写真を読み、AI に渡す data URI へ変換する。 */
async function loadPhotoDataUrls(photoKeys: string[]): Promise<string[]> {
	if (photoKeys.length === 0) {
		throw new Error("ジョブに写真が残っていません");
	}
	const out: string[] = [];
	for (const key of photoKeys) {
		const object = await env.AVATARS.get(key);
		if (!object) throw new Error(`写真が見つかりません: ${key}`);
		const bytes = new Uint8Array(await object.arrayBuffer());
		const mime = object.httpMetadata?.contentType ?? "image/jpeg";
		out.push(`data:${mime};base64,${toBase64(bytes)}`);
	}
	return out;
}

/** btoa はチャンクで呼ぶ(巨大文字列の一括連結を避ける。form-api の fileToDataUrl と同じ)。 */
function toBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * R2 の写真を消す。**失敗しても throw しない**——掃除の失敗で呼び出し側の本筋
 * (終端化・返却)を巻き込まないため。孤児が残ったことは記録に残す。
 */
async function deletePhotoObjects(
	keys: string[],
	context: { userId?: string; jobId: string; phase: string },
): Promise<void> {
	if (keys.length === 0) return;
	try {
		await env.AVATARS.delete(keys);
	} catch (e) {
		logError("failed to delete label analysis job photos", {
			...context,
			keys: keys.length,
			err: e,
		});
	}
}

type LabelAnalysisJobRow = typeof labelAnalysisJob.$inferSelect;

function toJobView(job: LabelAnalysisJobRow): LabelAnalysisJobView {
	const sighting: LabelJobSighting = {
		...(job.placeId ? { placeId: job.placeId } : {}),
		...(job.newPlaceName ? { newPlaceName: job.newPlaceName } : {}),
		...(job.seenOn ? { seenOn: job.seenOn } : {}),
	};
	return {
		jobId: job.id,
		status: job.status,
		photoCount: job.photoCount,
		route: job.route,
		kind: job.kind,
		...(Object.keys(sighting).length > 0 ? { sighting } : {}),
		// 引き継ぎ済み・失敗した回は空配列なので載せない
		...(job.photoKeys.length > 0
			? { photoUrls: job.photoKeys.map(imagePathForKey) }
			: {}),
		...(job.suggestions
			? { suggestions: job.suggestions as LabelSuggestions }
			: {}),
		...(job.wineListResult
			? { wineList: job.wineListResult as WineListAnalysisOutcome }
			: {}),
		...(job.actualTokens === null ? {} : { actualTokens: job.actualTokens }),
		...(job.error ? { error: job.error } : {}),
		...(job.consumedAt ? { consumed: true } : {}),
		...(job.entryId ? { entryId: job.entryId } : {}),
		createdAt: job.createdAt.getTime(),
		...(job.finishedAt ? { finishedAt: job.finishedAt.getTime() } : {}),
	};
}
