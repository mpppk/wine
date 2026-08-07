import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { labelAnalysisJob } from "#/db/schema";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import {
	isTerminalLabelJobStatus,
	LABEL_JOB_FAILED_ERROR_MESSAGE,
	LABEL_JOB_QUEUE_STALE_MS,
	LABEL_JOB_STALE_ERROR_MESSAGE,
	LABEL_JOB_STALE_MS,
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
import { logError, logInfo, logWarn } from "#/lib/logger";
import {
	resolveLabelPlan,
	restoreLabelPlan,
	runLabelAnalysisForJob,
} from "#/lib/services/ai-service";
import * as creditService from "#/lib/services/credit-service";
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
): Promise<SubmitLabelAnalysisJobResult> {
	if (photos.length === 0) {
		throw new BadRequestError("画像が指定されていません");
	}
	if (photos.length > MAX_PHOTOS_PER_ENTRY) {
		throw new BadRequestError(`写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです`);
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

	// 死んだコンシューマの残骸が枠を埋めたままにならないよう、数える前に決着させる。
	await settleStaleLabelAnalysisJobs(userId);
	const active = await countActiveLabelAnalysisJobs(userId);
	if (active >= MAX_CONCURRENT_LABEL_JOBS) {
		// 予約は投入時に立つので、連投されると残高が予約で埋まり本人の他のAI機能まで
		// ブロックされる。同期経路の「1リクエスト = 1解析」に相当する上限をここで課す。
		throw new TooManyRequestsError(
			`解析中のジョブが${MAX_CONCURRENT_LABEL_JOBS}件あります。完了してからもう一度お試しください。`,
		);
	}

	// D1読み・env解決は**予約より前**(#245)。
	const plan = await resolveLabelPlan(userId, photos.length);
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
			selectedEngine: plan.engine,
			route: plan.route,
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

	const plan = restoreLabelPlan({
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
		const done = await runLabelAnalysisForJob(job.userId, {
			imageDataUrls,
			plan,
			reservation,
			startedAt,
		});
		await finishJob(
			jobId,
			{ suggestions: done.value, actualTokens: done.charge.tokens },
			job.photoKeys,
		);
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
 * 写真は終端に到達した時点で消す。解析の**入力**であって成果物ではなく、残すと
 * R2 に解析回数ぶん溜まり続ける(退会時の一括削除は効くが、それまで消えない)。
 */
async function finishJob(
	jobId: string,
	outcome:
		| { suggestions: LabelSuggestions; actualTokens: number }
		| { error: string },
	photoKeys: string[],
): Promise<void> {
	const [row] = await db
		.update(labelAnalysisJob)
		.set({
			...("error" in outcome
				? { status: "failed" as const, error: outcome.error }
				: {
						status: "succeeded" as const,
						suggestions: outcome.suggestions,
						actualTokens: outcome.actualTokens,
					}),
			finishedAt: new Date(),
			photoKeys: [],
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
	// 行の更新に負けても写真は掃除する(掴んでいたのはこちらなので、置き去りにしない)。
	await deletePhotoObjects(photoKeys, { jobId, phase: "finish" });

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
	return {
		jobId: job.id,
		status: job.status,
		photoCount: job.photoCount,
		route: job.route,
		...(job.suggestions
			? { suggestions: job.suggestions as LabelSuggestions }
			: {}),
		...(job.actualTokens === null ? {} : { actualTokens: job.actualTokens }),
		...(job.error ? { error: job.error } : {}),
		...(job.consumedAt ? { consumed: true } : {}),
		createdAt: job.createdAt.getTime(),
		...(job.finishedAt ? { finishedAt: job.finishedAt.getTime() } : {}),
	};
}
