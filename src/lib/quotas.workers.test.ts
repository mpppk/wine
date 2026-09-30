import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { drunkWine, importBatch } from "#/db/schema";
import { ConflictError } from "#/lib/errors";
import { candidateCountsByType, listCandidates } from "#/lib/quiz/generators";
import type { QuizType } from "#/lib/quiz/types";
import {
	assertPhotoQuota,
	MAX_ENTRIES_PER_USER,
	MAX_PHOTO_BYTES_PER_USER,
	MAX_QUIZ_STATS_PER_USER,
} from "#/lib/quotas";
import { listRegions } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import {
	createDrunkWine,
	syncDrunkWinePhotos,
} from "./services/drunk-wine-service";
import { bulkRegisterFromScan } from "./services/import-batch-service";
import { recordAnswer } from "./services/quiz-service";

// ユーザあたり容量クォータ(#397)を実D1で検証する。件数・バイト数の上限は
// D1 で数えて判定するため、jsdom では検証できない。
//
// 上限値そのもの(5000件・2GB・15000行)は `#/lib/quotas` の定数が正で、ここに
// 書き写さない。ここで固定するのは「上限を超えたら 409 で拒否する」「上限内は
// 通す」という**振る舞い**の方。上限ちょうどの種まきは再帰CTEの1文で済ませ、
// 1件ずつの INSERT でテストを遅くしない。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `quota-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "quota tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

/** 再帰CTEで N 行をまとめて種まきする(SQLite の既定の再帰回数に収まるよう500行ずつ)。 */
async function seedEntries(userId: string, count: number): Promise<void> {
	const CHUNK = 500;
	for (let base = 0; base < count; base += CHUNK) {
		const n = Math.min(CHUNK, count - base);
		await db.run(
			sql`INSERT INTO drunk_wine (id, user_id, name) WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ${n}) SELECT ${userId} || '-entry-' || (x + ${base}), ${userId}, 'quota seed' FROM cnt`,
		);
	}
}

async function seedQuizStats(userId: string, count: number): Promise<void> {
	const CHUNK = 500;
	for (let base = 0; base < count; base += CHUNK) {
		const n = Math.min(CHUNK, count - base);
		await db.run(
			sql`INSERT INTO quiz_question_stat (user_id, question_key, quiz_type, region_id, last_answered_at) WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ${n}) SELECT ${userId}, ${userId} || '-quiz-' || (x + ${base}), 'colors', 'bourgogne', 1700000000000 FROM cnt`,
		);
	}
}

/** 1x1 の JPEG(実バイト検証を通る最小の写真)。 */
const JPEG_1X1 = new Uint8Array(
	[
		...atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
	].map((c) => c.charCodeAt(0)),
);

describe("entry quota", () => {
	it("上限内は登録できる", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "普段の1本" });
		expect(entry.name).toBe("普段の1本");
	});

	it(`上限(${MAX_ENTRIES_PER_USER}件)に達したら createDrunkWine を 409 で拒否する`, async () => {
		const userId = await freshUser();
		await seedEntries(userId, MAX_ENTRIES_PER_USER);
		const err = await createDrunkWine(userId, { name: "上限超過" }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConflictError);
		expect((err as ConflictError).status).toBe(409);
	});

	it("上限到達時は一括登録の新規銘柄も 409 で拒否する(直接 INSERT の素通りを防ぐ)", async () => {
		const userId = await freshUser();
		await seedEntries(userId, MAX_ENTRIES_PER_USER);
		const err = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "素通りできない" } }],
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect((err as ConflictError).status).toBe(409);
	});

	it("新規0件の一括登録(既存への紐付けのみ)は上限到達でも通す", async () => {
		const userId = await freshUser();
		await seedEntries(userId, MAX_ENTRIES_PER_USER - 1);
		const existing = await createDrunkWine(userId, { name: "既存" });
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ existingId: existing.id }],
		});
		expect(result.matchedCount).toBe(1);
		expect(result.createdCount).toBe(0);
	});
});

describe("photo quota", () => {
	/** 写真キーだけを D1 直書きで積む(R2 実体は要らない。見積もりは枚数×上限で行う)。 */
	async function fillPhotoKeys(userId: string, count: number): Promise<string> {
		const entry = await createDrunkWine(userId, { name: "写真枠" });
		await db
			.update(drunkWine)
			.set({
				photoKeys: Array.from({ length: count }, (_, i) => `quota/${i}.jpg`),
			})
			.where(eq(drunkWine.id, entry.id));
		return entry.id;
	}

	it("上限内は写真を保存できる", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "写真つき" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);
		expect(saved.photoUrls).toHaveLength(1);
	});

	it(`総バイト上限(${MAX_PHOTO_BYTES_PER_USER}バイトの見積もり)を超えたら 409 で拒否し、R2 に書かない`, async () => {
		const userId = await freshUser();
		// 410枚 × 5MB = 2050MiB で上限(2GiB)超。1バイトでも足すと超過する。
		const entryId = await fillPhotoKeys(userId, 410);
		const before = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entryId));
		const err = await syncDrunkWinePhotos(userId, entryId, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect((err as ConflictError).status).toBe(409);
		// 拒否は R2 へ書く前なので、D1 の写真集合も変わらない。
		const after = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entryId));
		expect(after[0]?.photoKeys).toEqual(before[0]?.photoKeys);
	});

	it("バッチ写真も総量に数える(エントリ写真だけ見ると素通りする)", async () => {
		const userId = await freshUser();
		await db.insert(importBatch).values({
			id: `${userId}-batch`,
			userId,
			photoKeys: Array.from({ length: 410 }, (_, i) => `quota/b/${i}.jpg`),
		});
		const err = await assertPhotoQuota(userId, 1).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConflictError);
	});
});

// recordAnswer は実在する問題キーしか受け付けないため、合成キーではなく
// listCandidates が返す本物のキーを使う必要がある。
const region = listRegions().find((r) => r.enabled);
if (!region)
	throw new Error("有効な地域が1つも無い(テストデータ前提が崩れている)");
const regionId: RegionId = region.id;
const counts = candidateCountsByType(regionId);
const quizType = (Object.keys(counts) as QuizType[]).find((t) => counts[t] > 0);
if (!quizType) throw new Error(`候補問題を持つ形式が無い: ${regionId}`);
const realKeys = listCandidates(regionId, [quizType]);

describe("quiz quota", () => {
	it("上限内は新規キーの回答を記録できる", async () => {
		const userId = await freshUser();
		const snapshot = await recordAnswer(userId, {
			questionKey: realKeys[0] as string,
			wasCorrect: true,
		});
		expect(snapshot.existed).toBe(false);
	});

	it(`上限(${MAX_QUIZ_STATS_PER_USER}行)に達したら新規キーを 409 で拒否する`, async () => {
		const userId = await freshUser();
		await seedQuizStats(userId, MAX_QUIZ_STATS_PER_USER);
		const err = await recordAnswer(userId, {
			questionKey: realKeys[0] as string,
			wasCorrect: true,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect((err as ConflictError).status).toBe(409);
	});

	it("上限到達でも既存キーへの回答(更新)は通す(学習の継続を妨げない)", async () => {
		const userId = await freshUser();
		// 上限のうち1行を本物のキーにしておく。
		await seedQuizStats(userId, MAX_QUIZ_STATS_PER_USER - 1);
		await recordAnswer(userId, {
			questionKey: realKeys[0] as string,
			wasCorrect: true,
		});
		// 上限到達後に同じキーへ回答しても、行は増えないので通る。
		const snapshot = await recordAnswer(userId, {
			questionKey: realKeys[0] as string,
			wasCorrect: false,
		});
		expect(snapshot.existed).toBe(true);
	});
});
