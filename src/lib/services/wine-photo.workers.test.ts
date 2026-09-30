import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { drunkWine, winePhoto } from "#/db/schema";
import type { PhotoKind } from "#/lib/ai/wine-list-extraction";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { imageKeyFromPath } from "#/lib/images/signed-url";
import {
	appendDrunkWinePhotoKeys,
	createDrunkWine,
	deleteDrunkWine,
	getDrunkWine,
	listDrunkWines,
	syncDrunkWinePhotos,
} from "./drunk-wine-service";
import { bulkRegisterFromScan } from "./import-batch-service";

// Issue #645: drunk_wine.photo_keys / photo_kinds の並列JSON配列を
// wine_photo 子テーブルへ移す。第1段階(expand)の検証:
// マイグレーションのバックフィル・書き込みの二重化・読み取りの子テーブル切替を
// 実D1(miniflare)で確認する。旧列の DROP は次PRなので、旧列のミラーも併せて見る。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `wp-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "wine photo tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

/** 子テーブルの行を position 順で読む(書き込みの確認用)。 */
async function childRows(entryId: string) {
	return db
		.select({
			r2Key: winePhoto.r2Key,
			kind: winePhoto.kind,
			position: winePhoto.position,
		})
		.from(winePhoto)
		.where(eq(winePhoto.drunkWineId, entryId))
		.orderBy(asc(winePhoto.position));
}

/** 0045 のバックフィル文(INSERT OR IGNORE ... json_each ...)を実物から抜く。 */
function backfillQuery(): string {
	const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0045_"));
	if (!migration)
		throw new Error("0045 migration not found in TEST_MIGRATIONS");
	const query = migration.queries.find((q) =>
		q.trimStart().startsWith("INSERT OR IGNORE INTO `wine_photo`"),
	);
	if (!query) throw new Error("backfill query not found in 0045 migration");
	return query;
}

const JPEG_1X1 = Uint8Array.from(
	atob(
		"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
	),
	(c) => c.charCodeAt(0),
);

describe("0045 のバックフィル", () => {
	it("旧列の写真を子テーブルへ展開する(由来の正規化つき)", async () => {
		const userId = await freshUser();
		const normal = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id: normal,
			userId,
			name: "通常",
			photoKeys: ["wines/u/e/k1.jpg", "wines/u/e/k2.jpg"],
			photoKinds: ["web", "bottle"],
		});
		// 由来が短いぶんは bottle に倒れる
		const short = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id: short,
			userId,
			name: "短い",
			photoKeys: ["wines/u/e/a.jpg", "wines/u/e/b.jpg"],
			photoKinds: ["web"],
		});
		// 未知値は bottle に倒れる
		const weird = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id: weird,
			userId,
			name: "未知",
			photoKeys: ["wines/u/e/x.jpg"],
			photoKinds: ["mystery" as unknown as PhotoKind],
		});
		// 写真なし行は何も起きない
		const empty = crypto.randomUUID();
		await db.insert(drunkWine).values({ id: empty, userId, name: "空" });

		await env.DB.prepare(backfillQuery()).run();

		expect(await childRows(normal)).toEqual([
			{ r2Key: "wines/u/e/k1.jpg", kind: "web", position: 0 },
			{ r2Key: "wines/u/e/k2.jpg", kind: "bottle", position: 1 },
		]);
		expect(await childRows(short)).toEqual([
			{ r2Key: "wines/u/e/a.jpg", kind: "web", position: 0 },
			{ r2Key: "wines/u/e/b.jpg", kind: "bottle", position: 1 },
		]);
		expect(await childRows(weird)).toEqual([
			{ r2Key: "wines/u/e/x.jpg", kind: "bottle", position: 0 },
		]);
		expect(await childRows(empty)).toEqual([]);
	});

	it("バックフィルの再適用では行が増えない(冪等)", async () => {
		const userId = await freshUser();
		const id = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id,
			userId,
			name: "冪等",
			photoKeys: ["wines/u/e/idem.jpg"],
			photoKinds: ["web"],
		});

		await env.DB.prepare(backfillQuery()).run();
		await env.DB.prepare(backfillQuery()).run();

		expect(await childRows(id)).toEqual([
			{ r2Key: "wines/u/e/idem.jpg", kind: "web", position: 0 },
		]);
	});
});

describe("書き込みの二重化と読み取りの切替", () => {
	it("sync は子テーブルと旧列の両方へ書き、読み取りは子テーブルから返す", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "二重化" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);

		expect(saved.photoUrls).toHaveLength(1);
		expect(saved.photoKinds).toEqual(["bottle"]);
		const key = imageKeyFromPath(saved.photoUrls[0] as string);
		// 子テーブルが正本
		expect(await childRows(entry.id)).toEqual([
			{ r2Key: key, kind: "bottle", position: 0 },
		]);
		// 旧列はミラー
		const [row] = await db
			.select({
				photoKeys: drunkWine.photoKeys,
				photoKinds: drunkWine.photoKinds,
			})
			.from(drunkWine)
			.where(eq(drunkWine.id, entry.id));
		expect(row?.photoKeys).toEqual([key]);
		expect(row?.photoKinds).toEqual(["bottle"]);
	});

	it("子テーブルを直接変えると読み取りに反映される(旧列は見ない)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "正本" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);
		const key = imageKeyFromPath(saved.photoUrls[0] as string);

		// 旧列を触らず子テーブルだけ web に変える
		await db
			.update(winePhoto)
			.set({ kind: "web" })
			.where(eq(winePhoto.drunkWineId, entry.id));

		const reread = await getDrunkWine(userId, entry.id);
		expect(reread.photoKinds).toEqual(["web"]);
		const [row] = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entry.id));
		expect(row?.photoKeys).toEqual([key]);
	});

	it("旧列だけの行はフォールバックで読め、append で子テーブルへ寄る", async () => {
		const userId = await freshUser();
		const id = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id,
			userId,
			name: "旧列のみ",
			photoKeys: ["wines/u/e/legacy.jpg"],
			photoKinds: ["web"],
		});

		const before = await getDrunkWine(userId, id);
		expect(before.photoUrls).toHaveLength(1);
		expect(before.photoKinds).toEqual(["web"]);

		const { entry: after, adopted } = await appendDrunkWinePhotoKeys(
			userId,
			id,
			["wines/u/e/job.jpg"],
		);
		expect(adopted).toEqual(["wines/u/e/job.jpg"]);
		expect(after.photoUrls).toHaveLength(2);
		// 旧列だけのキーも子テーブルへ寄り、以降の読み取りは子テーブルから
		expect((await childRows(id)).map((row) => row.r2Key)).toEqual([
			"wines/u/e/legacy.jpg",
			"wines/u/e/job.jpg",
		]);
		expect(after.photoKinds).toEqual(["web", "bottle"]);
	});

	it("旧列だけの行も sync の layout で指定できる(repair 後に検証が通る)", async () => {
		const userId = await freshUser();
		const id = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id,
			userId,
			name: "旧列のみsync",
			photoKeys: ["wines/u/e/a.jpg", "wines/u/e/b.jpg"],
			photoKinds: ["web", "bottle"],
		});

		// 並べ替えて由来がキーに追随すること
		const saved = await syncDrunkWinePhotos(userId, id, [
			{ kind: "existing", key: "wines/u/e/b.jpg" },
			{ kind: "existing", key: "wines/u/e/a.jpg" },
		]);
		expect(saved.photoKinds).toEqual(["bottle", "web"]);
		expect(await childRows(id)).toEqual([
			{ r2Key: "wines/u/e/b.jpg", kind: "bottle", position: 0 },
			{ r2Key: "wines/u/e/a.jpg", kind: "web", position: 1 },
		]);
	});

	it("sync で外した写真は子テーブルの行も旧列も消える", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "外す" });
		await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);

		const cleared = await syncDrunkWinePhotos(userId, entry.id, []);
		expect(cleared.photoUrls).toEqual([]);
		expect(await childRows(entry.id)).toEqual([]);
		const [row] = await db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.id, entry.id));
		expect(row?.photoKeys).toEqual([]);
	});

	it("append は重複を足さず、上限超過分は捨てる", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "上限" });
		const keys = Array.from(
			{ length: MAX_PHOTOS_PER_ENTRY },
			(_, i) => `wines/${userId}/job/p${i}.jpg`,
		);
		const first = await appendDrunkWinePhotoKeys(userId, entry.id, keys);
		expect(first.adopted).toEqual(keys);
		expect(first.dropped).toEqual([]);

		// 同じキーの再送は採用しない
		const resend = await appendDrunkWinePhotoKeys(userId, entry.id, [
			keys[0] as string,
		]);
		expect(resend.adopted).toEqual([]);
		expect(resend.dropped).toEqual([]);
		expect((await childRows(entry.id)).length).toBe(MAX_PHOTOS_PER_ENTRY);

		// 上限超過は捨てる
		const over = await appendDrunkWinePhotoKeys(userId, entry.id, [
			`wines/${userId}/job/over.jpg`,
		]);
		expect(over.adopted).toEqual([]);
		expect(over.dropped).toEqual([`wines/${userId}/job/over.jpg`]);
	});

	it("エントリ削除で子テーブルの行も消える(cascade)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "消える" });
		await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);
		expect((await childRows(entry.id)).length).toBe(1);

		await deleteDrunkWine(userId, entry.id);
		expect(await childRows(entry.id)).toEqual([]);
	});

	it("一括登録の web 写真は子テーブルにも載る", async () => {
		const userId = await freshUser();
		const requested: string[] = [];
		const restore = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url,
			);
			return new Response(JPEG_1X1, {
				headers: { "content-type": "image/jpeg" },
			});
		}) as typeof fetch;
		try {
			await bulkRegisterFromScan(userId, {
				photoCount: 0,
				items: [
					{
						wine: { name: "Barolo" },
						webPhoto: { url: "https://example.com/barolo.jpg" },
					},
				],
			});
		} finally {
			globalThis.fetch = restore;
		}
		expect(requested).toHaveLength(1);

		const { entries } = await listDrunkWines(userId);
		expect(entries[0]?.photoKinds).toEqual(["web"]);
		const rows = await childRows(entries[0]?.id as string);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("web");
	});
});

describe("写真の並行更新 (#645 行単位版)", () => {
	it("並行した引き継ぎ(append同士)で両方の写真が子テーブルに残る", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "並行append" });
		const keyA = `wines/${userId}/job-a/photo-a.jpg`;
		const keyB = `wines/${userId}/job-b/photo-b.jpg`;
		const [ra, rb] = await Promise.all([
			appendDrunkWinePhotoKeys(userId, entry.id, [keyA]),
			appendDrunkWinePhotoKeys(userId, entry.id, [keyB]),
		]);
		expect([...ra.adopted, ...rb.adopted].sort()).toEqual([keyA, keyB].sort());
		const rows = await childRows(entry.id);
		expect(rows.map((row) => row.r2Key).sort()).toEqual([keyA, keyB].sort());
		const saved = await getDrunkWine(userId, entry.id);
		expect(saved.photoUrls).toHaveLength(2);
	});

	it("フォーム保存(sync)と引き継ぎ(append)が並行しても両方が残る", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "並行sync-append" });
		const jobKey = `wines/${userId}/job/photo.jpg`;
		await Promise.all([
			syncDrunkWinePhotos(userId, entry.id, [
				{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
			]),
			appendDrunkWinePhotoKeys(userId, entry.id, [jobKey]),
		]);
		const saved = await getDrunkWine(userId, entry.id);
		expect(saved.photoUrls).toHaveLength(2);
		const rows = await childRows(entry.id);
		expect(rows.map((row) => row.r2Key)).toContain(jobKey);
	});
});
