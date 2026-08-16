import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import {
	creditLedger,
	drunkWine,
	importBatch,
	labelAnalysisJob,
} from "#/db/schema";
import { AI_LABEL_MODEL } from "#/lib/ai/config";
import {
	LABEL_JOB_PHOTO_RETENTION_MS,
	LABEL_JOB_STALE_MS,
	MAX_CONCURRENT_LABEL_JOBS,
} from "#/lib/ai/label-job";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { REFUND_SUFFIX, SETTLE_SUFFIX } from "#/lib/credit/reservation";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import {
	BadRequestError,
	ConflictError,
	NotFoundError,
	TooManyRequestsError,
} from "#/lib/errors";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { createPlace, listPlaces } from "#/lib/services/place-service";
import {
	adoptLabelJobPhotosToBatch,
	attachLabelAnalysisJobEntry,
	consumeLabelAnalysisJob,
	getLabelAnalysisJob,
	getLabelAnalysisJobBadge,
	listPendingLabelAnalysisJobs,
	runLabelAnalysisJob,
	settleStaleLabelAnalysisJobs,
	submitLabelAnalysisJob,
	sweepConsumedJobPhotos,
} from "./label-job-service";

// エチケット解析ジョブのライフサイクルを実D1 + 実R2(miniflare)で検証する(Issue #460)。
//
// 見るのは推論の中身ではなく**状態機械とクレジットの帳尻**:
//  - ジョブ行が存在する = 予約が成立している(残高不足では行が作られない)
//  - 終端に到達する経路がどれも予約を閉じる(確定 or 返却)
//  - キューの at-least-once 再配信で二重実行・二重課金しない
//  - 死んだコンシューマの `running` が決着し、枠と UI のポーリングが解放される
//
// 推論そのものは env.AI をスタブして固定する(vitest.config.ts は AI バインディングを
// 用意しない。ai-service.workers.test.ts と同じ流儀)。

/** 最小の JPEG(SOI + APP0 "JFIF")。実バイト検証(#150)を通すために本物の先頭が要る。 */
const JPEG_BYTES = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
	0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

const photo = () => ({ bytes: JPEG_BYTES, mimeType: "image/jpeg" });

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "label-job-user", `${id}@example.test`)
		.run();
	return id;
}

async function seedPremiumUser(): Promise<string> {
	const id = await seedUser();
	await db.insert(subscription).values({
		id: `sub-${id}`,
		plan: "premium",
		referenceId: id,
		status: "active",
	});
	return id;
}

/** 宛先にする一括登録バッチ(#474)。写真はまだ無い状態で作る。 */
async function seedBatch(userId: string): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(importBatch).values({ id, userId });
	return id;
}

/** 宛先にするマイセラーのエントリ(#472)。名前だけの最小の行で足りる。 */
async function seedEntry(userId: string): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(drunkWine).values({ id, userId, name: "Chablis" });
	return id;
}

async function balanceOf(userId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT balance FROM credit_balance WHERE user_id = ?",
	)
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

async function ledgerRowsOf(userId: string) {
	return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

async function jobRow(jobId: string) {
	const [row] = await db
		.select()
		.from(labelAnalysisJob)
		.where(eq(labelAnalysisJob.id, jobId));
	return row;
}

/** env.AI を差し替える(答えの中身ではなく台帳と状態を固定するためのスタブ)。 */
function stubAiRun(run: () => Promise<unknown>): void {
	(env as unknown as { AI: { run: () => Promise<unknown> } }).AI = { run };
}

/** Workers AI 経路の成功応答。usage を返すので実測で確定する。 */
function workersAiOk(totalTokens = 300) {
	return async () => ({
		response: JSON.stringify({
			wine_name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
			vintage: 2020,
		}),
		usage: { total_tokens: totalTokens },
	});
}

/** 投入 → 成功。ユーザは標準経路(Workers AI)に固定する(高精度キーを立てない)。 */
async function submitOne(userId: string, photos = 1) {
	const result = await submitLabelAnalysisJob(
		userId,
		Array.from({ length: photos }, photo),
	);
	if (result.blocked) throw new Error("unexpected blocked");
	return result;
}

afterEach(() => {
	delete (env as unknown as { AI?: unknown }).AI;
	delete (env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
	delete (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("ジョブの投入", () => {
	it("予約を立てて queued の行を作り、写真をR2に置く", async () => {
		const userId = await seedUser();

		const { jobId, status } = await submitOne(userId, 2);

		expect(status).toBe("queued");
		const job = await jobRow(jobId);
		expect(job).toMatchObject({
			userId,
			status: "queued",
			photoCount: 2,
			route: "workers-ai",
		});
		// 予約が立っている = 残高が引かれ、consume 台帳がある。
		expect(await balanceOf(userId)).toBeLessThan(MONTHLY_CREDITS_FREE);
		expect(job?.reservedCredits).toBeGreaterThan(0);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId === job?.requestId)).toBe(true);

		// 写真は wines/{userId}/{jobId}/… に載る(マイセラー写真と同じ接頭辞)。
		expect(job?.photoKeys).toHaveLength(2);
		for (const key of job?.photoKeys ?? []) {
			expect(key.startsWith(`wines/${userId}/${jobId}/`)).toBe(true);
			expect(await env.AVATARS.get(key)).not.toBeNull();
		}
	});

	it("残高不足なら blocked を返し、ジョブ行を作らない", async () => {
		// 高精度経路(Claude)は写真1枚でも無料枠を超える見積になる。
		const userId = await seedUser();
		(env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY =
			"sk-ant-test";

		const result = await submitLabelAnalysisJob(userId, [photo()]);

		expect(result).toMatchObject({ blocked: true });
		// 「行が存在する = 予約が成立している」の不変条件。予約が立たない回に行を作ると、
		// 予約の無いジョブが推論を走らせてしまう。
		expect(
			await db
				.select()
				.from(labelAnalysisJob)
				.where(eq(labelAnalysisJob.userId, userId)),
		).toHaveLength(0);
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
	});

	// 投入時に入力された「どこで・いつ撮ったか」(#498)。完了を待たずに離脱した回の
	// 受け取りで、記録フォームの目撃記録へ復元するための唯一の手掛かり。
	describe("見かけた場所・見かけた日の保存", () => {
		it("既存の場所と見かけた日をジョブに残し、受け取り時に返す", async () => {
			const userId = await seedUser();
			const place = await createPlace(userId, { name: "エノテカ 渋谷" });

			const result = await submitLabelAnalysisJob(userId, [photo()], "label", {
				placeId: place.id,
				seenOn: "2026-08-09",
			});
			if (result.blocked) throw new Error("unexpected blocked");

			const row = await jobRow(result.jobId);
			expect(row?.placeId).toBe(place.id);
			expect(row?.newPlaceName).toBeNull();
			expect(row?.seenOn).toBe("2026-08-09");

			const view = await getLabelAnalysisJob(userId, result.jobId);
			expect(view.sighting).toEqual({
				placeId: place.id,
				seenOn: "2026-08-09",
			});
		});

		it("新しい場所は名前のまま残す(この時点では place を作らない)", async () => {
			const userId = await seedUser();

			const result = await submitLabelAnalysisJob(userId, [photo()], "label", {
				newPlaceName: "ビストロ・ド・パリ",
				seenOn: "2026-08-09",
			});
			if (result.blocked) throw new Error("unexpected blocked");

			expect((await jobRow(result.jobId))?.newPlaceName).toBe(
				"ビストロ・ド・パリ",
			);
			// 記録せずに離脱した回のぶんだけ空の場所が増えないこと
			expect(await listPlaces(userId)).toHaveLength(0);
		});

		it("何も入力していない回は sighting を返さない", async () => {
			const userId = await seedUser();
			const result = await submitOne(userId);

			const view = await getLabelAnalysisJob(userId, result.jobId);
			expect(view.sighting).toBeUndefined();
		});

		it("他人の場所は指定できず、予約も立てない", async () => {
			const userId = await seedUser();
			const otherUserId = await seedUser();
			const place = await createPlace(otherUserId, { name: "他人の店" });

			await expect(
				submitLabelAnalysisJob(userId, [photo()], "label", {
					placeId: place.id,
				}),
			).rejects.toThrow(NotFoundError);
			// 場所の確認は予約より前(台帳が空 = 月次付与にも到達していない)
			expect(await ledgerRowsOf(userId)).toHaveLength(0);
		});
	});

	it("画像が空なら予約せずに弾く (#480)", async () => {
		// 同期APIを消して入力検証がここへ集約された。**予約より前に落ちる**ことは
		// 台帳が空(月次付与すら走らない)であることで見る。
		const userId = await seedUser();

		await expect(submitLabelAnalysisJob(userId, [])).rejects.toThrow(
			BadRequestError,
		);
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});

	it("枚数の上限を超えたら予約せずに弾く (#480)", async () => {
		const userId = await seedUser();
		const tooMany = Array.from(
			{ length: MAX_PHOTOS_PER_IMPORT_BATCH + 1 },
			photo,
		);

		await expect(
			submitLabelAnalysisJob(userId, tooMany, "wine_list"),
		).rejects.toThrow(BadRequestError);
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});

	it("画像として認識できないファイルは拒否し、予約も立てない", async () => {
		const userId = await seedUser();

		await expect(
			submitLabelAnalysisJob(userId, [
				{ bytes: new TextEncoder().encode("<html>"), mimeType: "image/jpeg" },
			]),
		).rejects.toThrow(/画像として認識できない/);

		// 台帳が空 = 予約どころか月次付与にも到達していない(検証が予約より前にある証拠)。
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
		expect(
			await db
				.select()
				.from(labelAnalysisJob)
				.where(eq(labelAnalysisJob.userId, userId)),
		).toHaveLength(0);
	});

	it("同時実行の上限を超えたら受け付けない", async () => {
		const userId = await seedPremiumUser();
		for (let i = 0; i < MAX_CONCURRENT_LABEL_JOBS; i++) {
			await submitOne(userId);
		}

		await expect(submitLabelAnalysisJob(userId, [photo()])).rejects.toThrow(
			TooManyRequestsError,
		);
		// 上限で弾いた回は予約を立てない(立てると残高が予約で埋まる)。
		const jobs = await db
			.select()
			.from(labelAnalysisJob)
			.where(eq(labelAnalysisJob.userId, userId));
		expect(jobs).toHaveLength(MAX_CONCURRENT_LABEL_JOBS);
	});
});

describe("ジョブの実行", () => {
	it("解析に成功したら succeeded にして実測で確定し、写真は残す", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const reserved = (await jobRow(jobId))?.reservedCredits ?? 0;
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));

		await runLabelAnalysisJob(jobId);

		const job = await jobRow(jobId);
		expect(job).toMatchObject({ status: "succeeded" });
		expect(job?.suggestions).toMatchObject({ name: "Chablis Les Clos" });
		expect(job?.actualTokens).toBe(300);
		expect(job?.finishedAt).not.toBeNull();

		// 予約は settle で閉じる(返却ではない)。
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
		// 実測ぶんだけ消費し、予約との差分は戻る。
		expect(await balanceOf(userId)).toBeGreaterThan(
			MONTHLY_CREDITS_FREE - reserved,
		);

		// 写真は記録するワインの写真として引き継ぐので終端では消さない(#474)。
		// 引き継ぎと回収の詳細は「完了の受け取り」の節が見ている。
		expect(job?.photoKeys).toEqual(keys);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).not.toBeNull();
		}
	});

	it("推論が失敗したら failed にして予約を全額返却する", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(() => Promise.reject(new Error("model error")));

		// コンシューマは throw しない(再配信は claim ガードで空振りするため)。
		await runLabelAnalysisJob(jobId);

		const job = await jobRow(jobId);
		expect(job).toMatchObject({ status: "failed" });
		expect(job?.error).toBe("エチケットの解析に失敗しました");
		// 失敗した推論の料金をユーザに負担させない(#158)。
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});

	it("同じジョブが再配信されても2度は実行しない(at-least-once)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		let calls = 0;
		stubAiRun(async () => {
			calls += 1;
			return await workersAiOk(300)();
		});

		await runLabelAnalysisJob(jobId);
		const balanceAfterFirst = await balanceOf(userId);
		// 再配信(キューは at-least-once)。claim は `queued` の間しか成立しない。
		await runLabelAnalysisJob(jobId);

		expect(calls).toBe(1);
		expect(await balanceOf(userId)).toBe(balanceAfterFirst);
		expect((await jobRow(jobId))?.status).toBe("succeeded");
	});

	it("写真が読めなければ failed にして予約を返却する", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		// R2 障害・先行する掃除などで入力が消えている状況。
		for (const key of (await jobRow(jobId))?.photoKeys ?? []) {
			await env.AVATARS.delete(key);
		}
		stubAiRun(() => Promise.reject(new Error("must not be called")));

		await runLabelAnalysisJob(jobId);

		expect((await jobRow(jobId))?.status).toBe("failed");
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
	});
});

describe("stale の決着", () => {
	it("running のまま放置されたジョブを failed にして枠を解放する", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		// コンシューマが掴んだ直後に死んだ状態を作る。
		await db
			.update(labelAnalysisJob)
			.set({
				status: "running",
				startedAt: new Date(Date.now() - LABEL_JOB_STALE_MS - 1000),
			})
			.where(eq(labelAnalysisJob.id, jobId));

		expect(await settleStaleLabelAnalysisJobs(userId)).toBe(1);

		const job = await jobRow(jobId);
		expect(job).toMatchObject({ status: "failed" });
		expect(job?.error).toMatch(/時間内に完了しませんでした/);
		expect(job?.photoKeys).toEqual([]);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).toBeNull();
		}
		// UI がポーリングを止められるよう、未終端ジョブから外れる。
		expect(await listPendingLabelAnalysisJobs(userId)).toHaveLength(0);
	});

	it("stale 決着ではクレジットを返却しない(回収は reclaimOrphanReservations に任せる)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const balanceWhileReserved = await balanceOf(userId);
		await db
			.update(labelAnalysisJob)
			.set({
				status: "running",
				startedAt: new Date(Date.now() - LABEL_JOB_STALE_MS - 1000),
			})
			.where(eq(labelAnalysisJob.id, jobId));

		await settleStaleLabelAnalysisJobs(userId);

		// ここで返すと #246 の孤児回収と二重に戻す経路ができる。決着させるのは行だけ。
		expect(await balanceOf(userId)).toBe(balanceWhileReserved);
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);
	});

	it("しきい値内の running は決着させない(生きているジョブを殺さない)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		await db
			.update(labelAnalysisJob)
			.set({ status: "running", startedAt: new Date() })
			.where(eq(labelAnalysisJob.id, jobId));

		expect(await settleStaleLabelAnalysisJobs(userId)).toBe(0);
		expect((await jobRow(jobId))?.status).toBe("running");
	});

	it("stale 決着の後に生き延びたコンシューマが結果を上書きしない", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		await db
			.update(labelAnalysisJob)
			.set({
				status: "running",
				startedAt: new Date(Date.now() - LABEL_JOB_STALE_MS - 1000),
			})
			.where(eq(labelAnalysisJob.id, jobId));
		await settleStaleLabelAnalysisJobs(userId);

		// 決着後に届いた再配信。claim は queued の間しか成立しないので何も起きない。
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);

		expect((await jobRow(jobId))?.status).toBe("failed");
	});
});

describe("状態の取得", () => {
	it("終端に達したら残高も返す(UI が完了時に残高表示を更新できる)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(workersAiOk(300));

		const queued = await getLabelAnalysisJob(userId, jobId);
		// 未終端のポーリングでは残高を引かない(getBalance は月次付与の書き込みを伴う)。
		expect(queued).toMatchObject({ status: "queued", photoCount: 1 });
		expect(queued.balance).toBeUndefined();

		await runLabelAnalysisJob(jobId);
		const done = await getLabelAnalysisJob(userId, jobId);

		expect(done).toMatchObject({ status: "succeeded" });
		expect(done.suggestions).toMatchObject({ name: "Chablis Les Clos" });
		expect(done.balance).toBe(await balanceOf(userId));
	});

	it("他人のジョブは存在しないものとして扱う", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		const { jobId } = await submitOne(owner);

		// 403 ではなく 404。IDの存在有無を漏らさない。
		await expect(getLabelAnalysisJob(other, jobId)).rejects.toThrow(
			NotFoundError,
		);
	});

	it("未終端と、完了して未受け取りのジョブを一覧に出す", async () => {
		const userId = await seedUser();
		const queued = await submitOne(userId);
		const finished = await submitOne(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(finished.jobId);

		// 完了しても**受け取るまでは**一覧に残る(そうしないと結果を渡す先が無くなる)。
		const pending = await listPendingLabelAnalysisJobs(userId);
		expect(pending.map((job) => job.jobId).sort()).toEqual(
			[queued.jobId, finished.jobId].sort(),
		);
	});

	it("失敗したジョブは一覧に溜めない", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(() => Promise.reject(new Error("model error")));
		await runLabelAnalysisJob(jobId);

		// 失敗は投入した画面でその場で見せるもの。後から一覧に出しても利用者が取れる
		// 行動が無い(クレジットは返却済み)。
		expect(await listPendingLabelAnalysisJobs(userId)).toHaveLength(0);
	});
});

describe("完了の受け取り (#462)", () => {
	it("受け取ると候補が返り、バッジから消える", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);

		// 受け取る前: 完了1件としてバッジに出る。
		expect(await getLabelAnalysisJobBadge(userId)).toMatchObject({
			activeCount: 0,
			readyCount: 1,
			nextReadyJobId: jobId,
		});

		const { view, alreadyConsumed } = await consumeLabelAnalysisJob(
			userId,
			jobId,
		);

		expect(alreadyConsumed).toBe(false);
		expect(view.suggestions).toMatchObject({ name: "Chablis Les Clos" });
		// 受け取った後: バッジからも一覧からも消える(永久に出続けない)。
		expect(await getLabelAnalysisJobBadge(userId)).toMatchObject({
			activeCount: 0,
			readyCount: 0,
		});
		expect(await listPendingLabelAnalysisJobs(userId)).toHaveLength(0);
	});

	it("二重に受け取っても候補は返るが、既読であることが分かる", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		await consumeLabelAnalysisJob(userId, jobId);

		// リロード・戻る操作で2回目が来ても、候補が空になったりしない。
		const second = await consumeLabelAnalysisJob(userId, jobId);
		expect(second.alreadyConsumed).toBe(true);
		expect(second.view.suggestions).toMatchObject({ name: "Chablis Les Clos" });
	});

	it("未完了のジョブは受け取れない", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);

		await expect(consumeLabelAnalysisJob(userId, jobId)).rejects.toThrow(
			BadRequestError,
		);
	});

	it("他人のジョブは受け取れない", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		const { jobId } = await submitOne(owner);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);

		await expect(consumeLabelAnalysisJob(other, jobId)).rejects.toThrow(
			NotFoundError,
		);
		// 他人が触っても持ち主の受け取り待ちは減らない。
		expect(await getLabelAnalysisJobBadge(owner)).toMatchObject({
			readyCount: 1,
		});
	});

	it("宛先エントリを紐づけると、受け取り側が編集へ振り分けられる (#472)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const entryId = await seedEntry(userId);

		// 解析中に記録フォームを保存した、の再現。
		expect(
			await attachLabelAnalysisJobEntry(userId, jobId, entryId),
		).toMatchObject({ attached: true });

		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);

		// 受け取り導線はここを見て「新規登録」ではなく「そのワインを編集」を選ぶ。
		const view = await getLabelAnalysisJob(userId, jobId);
		expect(view.entryId).toBe(entryId);
		expect(view.suggestions).toMatchObject({ name: "Chablis Les Clos" });
	});

	it("宛先は最初に紐づいたエントリが勝つ (#472)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const first = await seedEntry(userId);
		const second = await seedEntry(userId);

		await attachLabelAnalysisJobEntry(userId, jobId, first);
		// 同じ解析結果が2つのエントリに宛てられると、開いたときどちらを直すか決まらない。
		expect(
			await attachLabelAnalysisJobEntry(userId, jobId, second),
		).toMatchObject({ attached: false });

		expect((await jobRow(jobId))?.entryId).toBe(first);
	});

	it("他人のエントリは宛先にできない (#472)", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		const { jobId } = await submitOne(owner);
		const othersEntry = await seedEntry(other);

		await expect(
			attachLabelAnalysisJobEntry(owner, jobId, othersEntry),
		).rejects.toThrow(NotFoundError);
		expect((await jobRow(jobId))?.entryId).toBeNull();
	});

	it("他人のジョブには紐づけられない (#472)", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		const { jobId } = await submitOne(owner);
		const othersEntry = await seedEntry(other);

		// 宛先は自分のエントリなので所有権チェックは通るが、ジョブが他人のものなので
		// 条件付き UPDATE が空振りする(存在を漏らさず、書き換えもしない)。
		expect(
			await attachLabelAnalysisJobEntry(other, jobId, othersEntry),
		).toMatchObject({ attached: false });
		expect((await jobRow(jobId))?.entryId).toBeNull();
	});

	it("成功したジョブの写真は残り、記録したワインの写真になる (#474)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId, 2);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);

		// 終端でも消えない(従来は解析の入力として捨てていた)。
		expect((await jobRow(jobId))?.photoKeys).toEqual(keys);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).not.toBeNull();
		}

		// 引き継ぐ前は受け取り画面がプレビューできるようURLを返す(#498)。
		expect((await getLabelAnalysisJob(userId, jobId)).photoUrls).toHaveLength(
			2,
		);

		const entryId = await seedEntry(userId);
		await attachLabelAnalysisJobEntry(userId, jobId, entryId);

		// エントリが所有し、ジョブは手放す(二重に消されないための単一所有)。
		const [entry] = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entryId));
		expect(entry?.photoKeys).toEqual(keys);
		expect((await jobRow(jobId))?.photoKeys).toEqual([]);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).not.toBeNull();
		}
		// 引き継いだ後はジョブのものではないので出さない(#498)
		expect(
			(await getLabelAnalysisJob(userId, jobId)).photoUrls,
		).toBeUndefined();
	});

	it("失敗したジョブの写真は残さない (#474)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(() => Promise.reject(new Error("model error")));

		await runLabelAnalysisJob(jobId);

		// 記録する結果が無い = 渡す先が無いので、従来どおり終端で消す。
		expect((await jobRow(jobId))?.photoKeys).toEqual([]);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).toBeNull();
		}
	});

	it("引き継ぎは冪等で、二重に足さない (#474)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId, 2);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const entryId = await seedEntry(userId);

		expect(
			(await attachLabelAnalysisJobEntry(userId, jobId, entryId)).adoptedPhotos,
		).toBe(keys.length);
		// 2回目(再送信・リロード)は所有が既に外れているので何もしない。
		expect(
			(await attachLabelAnalysisJobEntry(userId, jobId, entryId)).adoptedPhotos,
		).toBe(0);

		const [entry] = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entryId));
		expect(entry?.photoKeys).toEqual(keys);
	});

	it("走っているジョブでは引き継がない(解析がまだ写真を読む) (#474)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const entryId = await seedEntry(userId);

		// 解析中に記録フォームを保存した回。宛先は記録するが写真はまだ渡さない。
		const result = await attachLabelAnalysisJobEntry(userId, jobId, entryId);
		expect(result).toMatchObject({ attached: true, adoptedPhotos: 0 });
		expect((await jobRow(jobId))?.photoKeys).not.toEqual([]);

		// 完了後に受け取って保存すると、そこで引き継がれる。
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		expect(
			(await attachLabelAnalysisJobEntry(userId, jobId, entryId)).adoptedPhotos,
		).toBeGreaterThan(0);
	});

	it("フォームが同じ写真を保存済みなら引き継がない (#490)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId, 2);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const entryId = await seedEntry(userId);

		// 記録フォームからの投入は、投入と同時にその写真をエントリへ保存している。
		// 引き継ぐと同じ写真が2枚並ぶので、宛先だけを記録する。
		expect(
			await attachLabelAnalysisJobEntry(userId, jobId, entryId, {
				adoptPhotos: false,
			}),
		).toMatchObject({ attached: true, adoptedPhotos: 0 });

		const [entry] = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entryId));
		expect(entry?.photoKeys).toEqual([]);
		// 所有はジョブに残る(回収は保持期間の掃除に任せる)。
		expect((await jobRow(jobId))?.photoKeys).toEqual(keys);
	});

	it("引き継がなかった写真も保持期間を過ぎたら回収する (#490)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const entryId = await seedEntry(userId);
		await attachLabelAnalysisJobEntry(userId, jobId, entryId, {
			adoptPhotos: false,
		});
		await consumeLabelAnalysisJob(userId, jobId);
		await db
			.update(labelAnalysisJob)
			.set({
				consumedAt: new Date(Date.now() - LABEL_JOB_PHOTO_RETENTION_MS - 1000),
			})
			.where(eq(labelAnalysisJob.id, jobId));

		// 宛先はあるが引き取り手はいない(エントリは自前の写真を持っている)。
		// 宛先の有無で除外すると、この写真が誰からも参照されないまま R2 に残る。
		expect(await sweepConsumedJobPhotos(userId)).toBe(1);
		expect((await jobRow(jobId))?.photoKeys).toEqual([]);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).toBeNull();
		}
	});

	it("引き取り手が現れなかった写真は保持期間を過ぎたら回収する (#474)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		await consumeLabelAnalysisJob(userId, jobId);

		// 受け取った直後は消さない(候補を見てから翌日入力する使い方を潰さない)。
		expect(await sweepConsumedJobPhotos(userId)).toBe(0);

		await db
			.update(labelAnalysisJob)
			.set({
				consumedAt: new Date(Date.now() - LABEL_JOB_PHOTO_RETENTION_MS - 1000),
			})
			.where(eq(labelAnalysisJob.id, jobId));

		expect(await sweepConsumedJobPhotos(userId)).toBe(1);
		expect((await jobRow(jobId))?.photoKeys).toEqual([]);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).toBeNull();
		}
	});

	it("記録に使われたジョブは保持期間を過ぎても回収しない (#474)", async () => {
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const entryId = await seedEntry(userId);
		await attachLabelAnalysisJobEntry(userId, jobId, entryId);
		await consumeLabelAnalysisJob(userId, jobId);
		await db
			.update(labelAnalysisJob)
			.set({
				consumedAt: new Date(Date.now() - LABEL_JOB_PHOTO_RETENTION_MS - 1000),
			})
			.where(eq(labelAnalysisJob.id, jobId));

		// 所有はエントリへ移っているので、掃除の対象にしてはいけない
		// (対象にすると、記録したワインの写真が翌日消える)。
		expect(await sweepConsumedJobPhotos(userId)).toBe(0);
		const [entry] = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entryId));
		for (const key of entry?.photoKeys ?? []) {
			expect(await env.AVATARS.get(key)).not.toBeNull();
		}
	});

	it("バッチへ写真を引き継ぎ、ジョブは所有を手放す (#482)", async () => {
		const userId = await seedPremiumUser();
		const { jobId } = await submitOne(userId, 2);
		const keys = (await jobRow(jobId))?.photoKeys ?? [];
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const batchId = await seedBatch(userId);

		expect(
			await adoptLabelJobPhotosToBatch(userId, jobId, batchId),
		).toMatchObject({ adopted: keys.length });

		const [batch] = await db
			.select({ photoKeys: importBatch.photoKeys })
			.from(importBatch)
			.where(eq(importBatch.id, batchId));
		expect(batch?.photoKeys).toEqual(keys);
		// 単一所有にする(両方が同じキーを指すと、片方の掃除でもう片方が壊れる)。
		expect((await jobRow(jobId))?.photoKeys).toEqual([]);
		for (const key of keys) {
			expect(await env.AVATARS.get(key)).not.toBeNull();
		}
	});

	it("写真が保存済みのバッチには渡さない (#482)", async () => {
		// 目撃記録が photoIndex でバッチの写真配列を指すので、後から足すと添字がずれる
		// (`saveImportBatchPhotos` と同じ排他)。
		const userId = await seedPremiumUser();
		const { jobId } = await submitOne(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const batchId = await seedBatch(userId);
		await db
			.update(importBatch)
			.set({ photoKeys: ["wines/existing/photo.jpg"] })
			.where(eq(importBatch.id, batchId));

		await expect(
			adoptLabelJobPhotosToBatch(userId, jobId, batchId),
		).rejects.toThrow(ConflictError);

		// 弾かれた回はジョブが写真を持ったまま = 引き取り手はまだ現れていない。
		expect((await jobRow(jobId))?.photoKeys).not.toEqual([]);
	});

	it("上限を超えるぶんは足さずに捨て、R2からも消す (#482)", async () => {
		const userId = await seedPremiumUser();
		const { jobId } = await submitOne(userId);
		const batchId = await seedBatch(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);

		// 上限より1枚多いキーをジョブに持たせる(投入の上限は別途 API 側で効くので、
		// ここは引き継ぎ側の切り詰めだけを見る)。
		const extra = Array.from(
			{ length: MAX_PHOTOS_PER_IMPORT_BATCH + 1 },
			(_v, i) => `wines/${userId}/${jobId}/overflow-${i}.jpg`,
		);
		for (const key of extra) {
			await env.AVATARS.put(key, JPEG_BYTES, {
				httpMetadata: { contentType: "image/jpeg" },
			});
		}
		await db
			.update(labelAnalysisJob)
			.set({ photoKeys: extra })
			.where(eq(labelAnalysisJob.id, jobId));

		expect(
			await adoptLabelJobPhotosToBatch(userId, jobId, batchId),
		).toMatchObject({ adopted: MAX_PHOTOS_PER_IMPORT_BATCH });

		const [batch] = await db
			.select({ photoKeys: importBatch.photoKeys })
			.from(importBatch)
			.where(eq(importBatch.id, batchId));
		expect(batch?.photoKeys).toHaveLength(MAX_PHOTOS_PER_IMPORT_BATCH);
		// 溢れたぶんはジョブからも外れる = どこからも参照されないので実体を消す。
		const droppedKey = extra[MAX_PHOTOS_PER_IMPORT_BATCH];
		expect(droppedKey).toBeDefined();
		expect(await env.AVATARS.get(droppedKey as string)).toBeNull();
		expect(await env.AVATARS.get(extra[0] as string)).not.toBeNull();
	});

	it("他人のジョブ・他人のバッチには渡さない (#482)", async () => {
		const owner = await seedPremiumUser();
		const other = await seedPremiumUser();
		const { jobId } = await submitOne(owner);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(jobId);
		const othersBatch = await seedBatch(other);

		// 他人のジョブ: 存在を漏らさず黙って何もしない(adoptLabelJobPhotos と同じ)。
		expect(
			await adoptLabelJobPhotosToBatch(other, jobId, othersBatch),
		).toMatchObject({ adopted: 0 });
		// 他人のバッチ: 自分のジョブでも宛先が他人なら 404。
		await expect(
			adoptLabelJobPhotosToBatch(owner, jobId, othersBatch),
		).rejects.toThrow(NotFoundError);

		expect((await jobRow(jobId))?.photoKeys).not.toEqual([]);
		const [batch] = await db
			.select({ photoKeys: importBatch.photoKeys })
			.from(importBatch)
			.where(eq(importBatch.id, othersBatch));
		expect(batch?.photoKeys).toEqual([]);
	});

	it("走っているジョブでは渡さない(解析がまだ写真を読む) (#482)", async () => {
		const userId = await seedPremiumUser();
		const { jobId } = await submitOne(userId);
		const batchId = await seedBatch(userId);

		expect(
			await adoptLabelJobPhotosToBatch(userId, jobId, batchId),
		).toMatchObject({ adopted: 0 });
		expect((await jobRow(jobId))?.photoKeys).not.toEqual([]);
	});

	it("解析中と完了を別々に数える", async () => {
		const userId = await seedPremiumUser();
		const done = await submitOne(userId);
		stubAiRun(workersAiOk(300));
		await runLabelAnalysisJob(done.jobId);
		await submitOne(userId);
		await submitOne(userId);

		expect(await getLabelAnalysisJobBadge(userId)).toMatchObject({
			activeCount: 2,
			readyCount: 1,
			nextReadyJobId: done.jobId,
		});
	});
});

describe("一括抽出のジョブ (#474)", () => {
	/** Anthropic の応答をスタブする(SDK が掴む globalThis.fetch を差し替える)。 */
	function stubAnthropicWineList(wines: Record<string, unknown>[]): void {
		(env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY =
			"sk-ant-test";
		vi.stubGlobal("fetch", async () =>
			Response.json({
				content: [
					{ type: "text", text: JSON.stringify({ wines, truncated: false }) },
				],
				stop_reason: "end_turn",
				usage: {
					input_tokens: 3000,
					output_tokens: 500,
					server_tool_use: { web_search_requests: 2 },
				},
			}),
		);
	}

	it("同じ器で投入・実行され、結果は候補配列として載る", async () => {
		// 一括抽出は無料枠に収まらない見積になるのでプレミアムで回す。
		const userId = await seedPremiumUser();
		stubAnthropicWineList([
			{
				wine_name: "Chablis Les Clos",
				producer: "Vincent Dauvissat",
				vintage: 2020,
				grape_varieties: [],
				photo_indexes: [0],
			},
		]);

		const submitted = await submitLabelAnalysisJob(
			userId,
			[photo()],
			"wine_list",
		);
		if (submitted.blocked) throw new Error("unexpected blocked");
		expect((await jobRow(submitted.jobId))?.kind).toBe("wine_list");

		await runLabelAnalysisJob(submitted.jobId);

		const view = await getLabelAnalysisJob(userId, submitted.jobId);
		expect(view.status).toBe("succeeded");
		expect(view.kind).toBe("wine_list");
		// 結果は候補配列 + サマリ。エチケット解析の1件ぶんの形とは列ごと分けてある。
		expect(view.wineList?.candidates).toHaveLength(1);
		expect(view.wineList?.candidates[0]?.suggestions).toMatchObject({
			name: "Chablis Les Clos",
		});
		expect(view.suggestions).toBeUndefined();
	});

	it("バッジ・受け取り・stale の決着は種別によらず共通で効く", async () => {
		const userId = await seedPremiumUser();
		stubAnthropicWineList([
			{
				wine_name: "Meursault",
				producer: "Coche-Dury",
				vintage: 2019,
				grape_varieties: [],
				photo_indexes: [0],
			},
		]);
		const submitted = await submitLabelAnalysisJob(
			userId,
			[photo()],
			"wine_list",
		);
		if (submitted.blocked) throw new Error("unexpected blocked");
		await runLabelAnalysisJob(submitted.jobId);

		expect(await getLabelAnalysisJobBadge(userId)).toMatchObject({
			readyCount: 1,
			nextReadyJobId: submitted.jobId,
		});
		const { alreadyConsumed } = await consumeLabelAnalysisJob(
			userId,
			submitted.jobId,
		);
		expect(alreadyConsumed).toBe(false);
		expect(await getLabelAnalysisJobBadge(userId)).toMatchObject({
			readyCount: 0,
		});
	});

	it("枚数の上限は種別で違う(一括抽出のほうが多く受ける)", async () => {
		const userId = await seedPremiumUser();
		const photos = Array.from({ length: MAX_PHOTOS_PER_ENTRY + 1 }, photo);

		// エチケット解析ではエントリの上限で弾かれる枚数が、
		await expect(submitLabelAnalysisJob(userId, photos)).rejects.toThrow(
			BadRequestError,
		);
		// 一括抽出では受け付けられる(リストや棚を分割して撮るため)。
		stubAnthropicWineList([]);
		const submitted = await submitLabelAnalysisJob(userId, photos, "wine_list");
		expect(submitted.blocked).toBe(false);
	});
});

describe("実行経路", () => {
	it("投入時に解決した経路をコンシューマが再解決しない", async () => {
		// 投入時はキー未設定 = workers-ai で予約する。
		const userId = await seedUser();
		const { jobId } = await submitOne(userId);
		expect((await jobRow(jobId))?.route).toBe("workers-ai");

		// 実行までの間にシークレットが増えても、予約は workers-ai の見積で立っている。
		// 経路を再解決すると予約と実行が食い違う(Claude の推論に Llama の予約)。
		(env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY =
			"sk-ant-test";
		vi.stubGlobal("fetch", () => {
			throw new Error("Anthropic must not be called");
		});
		stubAiRun(workersAiOk(300));

		await runLabelAnalysisJob(jobId);

		expect((await jobRow(jobId))?.status).toBe("succeeded");
		// 実行記録・課金も Workers AI の単価。
		const settle = (await ledgerRowsOf(userId)).find((r) =>
			r.requestId?.endsWith(SETTLE_SUFFIX),
		);
		expect(settle).toBeDefined();
		expect(AI_LABEL_MODEL).toContain("llama");
	});
});
