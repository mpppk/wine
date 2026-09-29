// 一括登録サブドメインの結合テスト。drunk-wine-service.workers.test.ts から
// 機械的に分離したもの(Issue #406)。bulkRegisterFromScan / undoImportBatch /
// listImportBatches / saveImportBatchPhotos / getImportBatch / getImportBatchDetail /
// adoptImportBatchPhotoKeys と銘柄写真の手当て(#473/#574)をここで検証する。
// 挙動変更なしの純移動で、セットアップ用の銘柄・場所・目撃記録の関数は
// drunk-wine-service / place-service から import する。

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { drunkWine, importBatch, wineEncounter } from "#/db/schema";
import { thumbKeyForPhotoKey } from "#/lib/drunk-wine/photo";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { imageKeyFromPath } from "#/lib/images/signed-url";
import type { BulkRegisterFromScanInput } from "#/lib/import-batch/schema";
import {
	addWineTasting,
	createDrunkWine,
	deleteDrunkWine,
	getDrunkWine,
	listDrunkWines,
	listWineEncounters,
	listWineSightings,
	listWineTastings,
	syncDrunkWinePhotos,
} from "./drunk-wine-service";
import {
	adoptImportBatchPhotoKeys,
	bulkRegisterFromScan,
	getImportBatch,
	getImportBatchDetail,
	listImportBatches,
	saveImportBatchPhotos,
	undoImportBatch,
} from "./import-batch-service";
import { createPlace, listPlaces } from "./place-service";

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `ib-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "import batch tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

describe("bulkRegisterFromScan", () => {
	const item = (
		partial: Partial<BulkRegisterFromScanInput["items"][number]> = {},
	): BulkRegisterFromScanInput["items"][number] => ({
		wine: { name: "Chablis" },
		...partial,
	});

	it("銘柄・目撃記録・バッチをまとめて作り、集計キャッシュを更新する", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 2,
			items: [
				item({
					wine: { name: "Chablis Les Clos", vintage: 2020 },
					sighting: { photoIndex: 0, price: 24000 },
				}),
				item({ wine: { name: "Barolo Brunate" }, sighting: { photoIndex: 1 } }),
			],
		});

		expect(result).toMatchObject({
			createdCount: 2,
			matchedCount: 0,
			encounterCount: 2,
			drankCount: 0,
			placeId: null,
		});

		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			// 見かけただけなので「飲んだ」記録は作られない(status も spotted)
			expect(entry.status).toBe("spotted");
			expect(entry.tastingCount).toBe(0);
			// 集計キャッシュが同じ batch で更新されている
			expect(entry.encounterCount).toBe(1);
			expect(entry.lastEncounteredOn).toBe("2026-08-01");
		}

		const sightings = await listWineSightings(
			userId,
			entries.find((e) => e.name === "Chablis Les Clos")?.id ?? "",
		);
		expect(sightings[0]).toMatchObject({
			batchId: result.batchId,
			photoIndex: 0,
			price: 24000,
			seenOn: "2026-08-01",
		});
	});

	it("既存エントリには銘柄を作らず目撃記録だけを足す", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
		});

		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [item({ wine: undefined, existingId: existing.id })],
		});

		expect(result).toMatchObject({ createdCount: 0, matchedCount: 1 });
		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		// 既存の状態(飲み終わった)は書き換えない。体験記録が増えるだけ
		// (元からの飲用1件 + バッチが足した drank=0 の1件で全体験は2件)
		expect(entries[0]).toMatchObject({
			id: existing.id,
			status: "finished",
			encounterCount: 2,
			tastingCount: 1,
		});
	});

	it("「飲んだ」指定があれば drank=1 の体験記録を1行だけ作る", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				item({
					wine: { name: "飲んだワイン", status: "finished" },
					tasting: { drankOn: "2026-07-31", rating: 4 },
				}),
			],
		});
		expect(result).toMatchObject({ encounterCount: 1, drankCount: 1 });
		const { entries } = await listDrunkWines(userId);
		// 旧2テーブル体制では2行だったものが、統合で1行になる
		expect(entries[0]).toMatchObject({
			status: "finished",
			tastingCount: 1,
			lastDrankOn: "2026-07-31",
			lastRating: 4,
			encounterCount: 1,
			lastEncounteredOn: "2026-07-31",
		});
		// 体験記録は drank=1 の1行だけで、日付・評価が載っている
		const encounters = await listWineEncounters(userId, entries[0]?.id ?? "");
		expect(encounters).toHaveLength(1);
		expect(encounters[0]).toMatchObject({
			drank: true,
			occurredOn: "2026-07-31",
			rating: 4,
		});
	});

	it("新規で場所を作ると、全ての目撃記録がその場所を指す", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			newPlace: { name: "ビストロ・クロード" },
			photoCount: 0,
			items: [item({ wine: { name: "A" } }), item({ wine: { name: "B" } })],
		});

		expect(result.placeId).not.toBeNull();
		const places = await listPlaces(userId);
		expect(places).toHaveLength(1);
		const { entries } = await listDrunkWines(userId);
		for (const entry of entries) {
			const [sighting] = await listWineSightings(userId, entry.id);
			expect(sighting?.placeId).toBe(result.placeId);
			expect(sighting?.placeName).toBe("ビストロ・クロード");
		}
	});

	it("他ユーザのエントリを指定した登録は丸ごと失敗する(部分適用しない)", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const theirs = await createDrunkWine(stranger, { name: "他人のワイン" });

		await expect(
			bulkRegisterFromScan(owner, {
				photoCount: 0,
				items: [
					item({ wine: { name: "巻き添えになってはいけない" } }),
					item({ wine: undefined, existingId: theirs.id }),
				],
			}),
		).rejects.toThrow("Entry not found");

		// 1件目も作られていない = 検証は全件そろってから
		expect((await listDrunkWines(owner)).entries).toHaveLength(0);
	});

	it("他ユーザの場所を指した登録は失敗する(FKは所有者を見ないため)", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const theirPlace = await createPlace(stranger, { name: "他人の行きつけ" });

		await expect(
			bulkRegisterFromScan(owner, {
				placeId: theirPlace.id,
				photoCount: 0,
				items: [item()],
			}),
		).rejects.toThrow("Place not found");
		expect((await listDrunkWines(owner)).entries).toHaveLength(0);
	});

	it("未知のAOPを含む登録は丸ごと失敗する", async () => {
		const userId = await freshUser();
		await expect(
			bulkRegisterFromScan(userId, {
				photoCount: 0,
				items: [
					item({ wine: { name: "正しい" } }),
					item({ wine: { name: "壊れている", aopId: "no-such-aop" } }),
				],
			}),
		).rejects.toBeInstanceOf(BadRequestError);
		expect((await listDrunkWines(userId)).entries).toHaveLength(0);
	});
});

describe("一括登録の銘柄写真", () => {
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	/** web の画像取得を差し替える。呼ばれたURLも記録して、取りに行った/行かなかったを見る。 */
	function stubImageFetch(response: () => Response): string[] {
		const requested: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (input: RequestInfo | URL) => {
				requested.push(
					typeof input === "string"
						? input
						: input instanceof URL
							? input.href
							: input.url,
				);
				return response();
			},
		);
		return requested;
	}

	function jpegResponse(): Response {
		return new Response(JPEG_1X1_BYTES, {
			headers: { "content-type": "image/jpeg" },
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("web画像を取り込んで銘柄の写真にし、ズレの注記をコメントへ追記する", async () => {
		const userId = await freshUser();
		const requested = stubImageFetch(jpegResponse);

		await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: { name: "Barolo", note: "【香り・味わい】\nタール。" },
					webPhoto: {
						url: "https://example.com/barolo.jpg",
						note: "写真は2019年のものです。",
					},
				},
			],
		});

		expect(requested).toEqual(["https://example.com/barolo.jpg"]);
		const { entries } = await listDrunkWines(userId);
		expect(entries[0]?.photoUrls).toHaveLength(1);
		// 取り込めた銘柄にだけ注記が付く
		expect(entries[0]?.note).toContain("タール。");
		expect(entries[0]?.note).toContain("【写真について】");
		expect(entries[0]?.note).toContain("写真は2019年のものです。");
	});

	it("取得に失敗しても登録は成立し、写真も注記も付かない", async () => {
		const userId = await freshUser();
		stubImageFetch(() => new Response("nope", { status: 404 }));

		await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: { name: "Barolo" },
					webPhoto: {
						url: "https://example.com/missing.jpg",
						note: "写真は2019年のものです。",
					},
				},
			],
		});

		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.photoUrls).toEqual([]);
		// 画像が無いのに「写真は2019年のものです」だけ残ると意味が通らない
		expect(entries[0]?.note).toBeNull();
	});

	it("画像を装ったHTMLは保存しない(実バイトで判定する)", async () => {
		const userId = await freshUser();
		stubImageFetch(
			() =>
				new Response("<html>404</html>", {
					headers: { "content-type": "image/jpeg" },
				}),
		);

		await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: { name: "Barolo" },
					webPhoto: { url: "https://example.com/notreally.jpg" },
				},
			],
		});
		expect((await listDrunkWines(userId)).entries[0]?.photoUrls).toEqual([]);
	});

	it("申告 image/jpg（非標準エイリアス）のJPEGも取り込む(#593)", async () => {
		// VivinoのCDNのように image/jpg を返すサイトがある。実体がJPEGなら
		// image/jpeg として採用し、銘柄の写真にする。
		const userId = await freshUser();
		stubImageFetch(
			() =>
				new Response(JPEG_1X1_BYTES, {
					headers: { "content-type": "image/jpg" },
				}),
		);

		await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: { name: "Barolo" },
					webPhoto: { url: "https://example.com/barolo.jpg" },
				},
			],
		});
		const { entries } = await listDrunkWines(userId);
		expect(entries[0]?.photoUrls).toHaveLength(1);
		expect(entries[0]?.photoKinds).toEqual(["web"]);
	});

	it("https でないURLは取りに行かない", async () => {
		const userId = await freshUser();
		const requested = stubImageFetch(jpegResponse);

		await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: { name: "Barolo" },
					webPhoto: { url: "http://example.com/barolo.jpg" },
				},
			],
		});
		expect(requested).toEqual([]);
		expect((await listDrunkWines(userId)).entries[0]?.photoUrls).toEqual([]);
	});

	it("写真が無い銘柄には一括登録の写真を複製する(3段目のフォールバック)", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [{ wine: { name: "棚の1本" }, sighting: { photoIndex: 0 } }],
		});
		const batch = await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		const { entries } = await listDrunkWines(userId);
		const photoUrl = entries[0]?.photoUrls[0];
		expect(photoUrl).toBeTruthy();
		// **参照ではなく複製**。共有していると、銘柄1件を消しただけでバッチ写真や
		// 他の銘柄の写真まで消える。
		expect(photoUrl).not.toBe(batch.photoUrls[0]);
		expect(
			await env.AVATARS.head(imageKeyFromPath(photoUrl as string)),
		).not.toBeNull();
		expect(
			await env.AVATARS.head(imageKeyFromPath(batch.photoUrls[0] as string)),
		).not.toBeNull();
	});

	it("ジョブから引き継いだ回も銘柄へ複製する(#617)", async () => {
		// 一括抽出はジョブ経路(#474)なので、**バッチに写真が載る入口は2つある**:
		// アップロード(`saveImportBatchPhotos`)と、解析ジョブからの引き継ぎ
		// (`adoptImportBatchPhotoKeys`)。以前は前者だけが銘柄への複製を呼んでおり、
		// 受け取って開いた回に登録した銘柄は写真を1枚も持てなかった(レビュー画面には
		// ジョブの写真が出ているので、利用者から見ると「登録したら消えた」)。
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [
				{ wine: { name: "受け取って開いた回" }, sighting: { photoIndex: 0 } },
			],
		});
		// 解析ジョブが投入時に置いた写真(キーの2つ目のセグメントはジョブID)。
		const jobKey = `wines/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
		await env.AVATARS.put(jobKey, JPEG_1X1_BYTES, {
			httpMetadata: { contentType: "image/jpeg" },
		});

		const { adopted } = await adoptImportBatchPhotoKeys(
			userId,
			result.batchId,
			[jobKey],
		);
		expect(adopted).toEqual([jobKey]);

		const { entries } = await listDrunkWines(userId);
		const photoUrl = entries[0]?.photoUrls[0];
		expect(photoUrl).toBeTruthy();
		expect(entries[0]?.photoKinds).toEqual(["bottle"]);
		// アップロード経路と同じく**参照ではなく複製**(バッチ取り消しで銘柄の写真が消えない)
		expect(imageKeyFromPath(photoUrl as string)).not.toBe(jobKey);
		expect(
			await env.AVATARS.head(imageKeyFromPath(photoUrl as string)),
		).not.toBeNull();
		expect(await env.AVATARS.head(jobKey)).not.toBeNull();
	});

	it("引き継ぎも申告枚数と照合する(#405 の関門を共有する)", async () => {
		// 目撃記録の photoIndex が指す配列の枚数が申告とズレると「別の写真で見かけた
		// ことになる」。アップロード経路だけが持っていた照合を共通の関門へ移したので、
		// 引き継ぎ経路でも同じ条件で弾く。
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 2,
			items: [{ wine: { name: "枚数不一致" }, sighting: { photoIndex: 0 } }],
		});
		const jobKey = `wines/${userId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;

		await expect(
			adoptImportBatchPhotoKeys(userId, result.batchId, [jobKey]),
		).rejects.toThrow(BadRequestError);
		const [batch] = await db
			.select({ photoKeys: importBatch.photoKeys })
			.from(importBatch)
			.where(eq(importBatch.id, result.batchId));
		expect(batch?.photoKeys).toEqual([]);
	});

	it("既に写真がある銘柄(web画像で手当て済み)は上書きしない", async () => {
		const userId = await freshUser();
		stubImageFetch(jpegResponse);
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [
				{
					wine: { name: "web画像あり" },
					webPhoto: { url: "https://example.com/a.jpg" },
					sighting: { photoIndex: 0 },
				},
			],
		});
		const before = (await listDrunkWines(userId)).entries[0]?.photoUrls;
		expect(before).toHaveLength(1);

		await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);
		expect((await listDrunkWines(userId)).entries[0]?.photoUrls).toEqual(
			before,
		);
	});

	it("既存エントリに目撃を足しただけの銘柄には写真を足さない", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
		});
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [{ existingId: existing.id, sighting: { photoIndex: 0 } }],
		});
		await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);
		expect((await getDrunkWine(userId, existing.id)).photoUrls).toEqual([]);
	});
});

describe("undoImportBatch", () => {
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	async function batchRow(id: string) {
		const [row] = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, id));
		return row;
	}

	it("新規作成したエントリだけを削除し、既存エントリは目撃記録だけ取り消して集計を再計算する", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
			tasting: { drankOn: "2020-01-01" },
		});

		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 0,
			items: [
				{ wine: { name: "新規のワイン" } },
				{ wine: undefined, existingId: existing.id },
			],
		});
		expect((await listDrunkWines(userId)).entries).toHaveLength(2);

		const undone = await undoImportBatch(userId, result.batchId);
		expect(undone.deletedCount).toBe(1);

		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		// 既存エントリは消えず、体験記録だけ取り消されて集計が元に戻る
		expect(entries[0]).toMatchObject({
			id: existing.id,
			status: "finished",
			// 飲用記録(バッチと無関係)はそのまま残る = 全体験はその1件に戻る
			encounterCount: 1,
			lastEncounteredOn: "2020-01-01",
			tastingCount: 1,
			lastDrankOn: "2020-01-01",
		});
		expect(await listWineSightings(userId, existing.id)).toHaveLength(0);
		expect(await batchRow(result.batchId)).toBeUndefined();
	});

	it("バッチが作った場所は削除しない", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			newPlace: { name: "取り消しても残る店" },
			photoCount: 0,
			items: [{ wine: { name: "取り消されるワイン" } }],
		});

		await undoImportBatch(userId, result.batchId);

		const places = await listPlaces(userId);
		expect(places.map((p) => p.name)).toContain("取り消しても残る店");
	});

	it("バッチ写真とエントリ写真をR2から削除する", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [{ wine: { name: "写真つき" }, sighting: { photoIndex: 0 } }],
		});
		const batch = await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);
		const batchPhotoKey = imageKeyFromPath(batch.photoUrls[0] as string);

		const { entries } = await listDrunkWines(userId);
		const entryId = entries[0]?.id as string;
		const savedEntryPhoto = await syncDrunkWinePhotos(userId, entryId, [
			{
				kind: "new",
				bytes: JPEG_1X1_BYTES,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1_BYTES,
			},
		]);
		const entryPhotoKey = imageKeyFromPath(
			savedEntryPhoto.photoUrls[0] as string,
		);

		await undoImportBatch(userId, result.batchId);

		expect(await env.AVATARS.head(batchPhotoKey)).toBeNull();
		expect(await env.AVATARS.head(entryPhotoKey)).toBeNull();
		expect(
			await env.AVATARS.head(thumbKeyForPhotoKey(entryPhotoKey)),
		).toBeNull();
	});

	it("他ユーザのバッチは取り消せない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const result = await bulkRegisterFromScan(owner, {
			photoCount: 0,
			items: [{ wine: { name: "他人のバッチ" } }],
		});

		await expect(
			undoImportBatch(stranger, result.batchId),
		).rejects.toBeInstanceOf(NotFoundError);
		expect((await listDrunkWines(owner)).entries).toHaveLength(1);
	});

	it("存在しないバッチIDは NotFoundError", async () => {
		const userId = await freshUser();
		await expect(
			undoImportBatch(userId, "no-such-batch"),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	// #393: 一括登録は既存エントリにも試飲記録を足せる(「このワインを飲んだ」)。
	// 取り消しがこれを消し残すと、ユーザには「取り消したのに飲んだ記録と評価が残る」
	// という無言のデータ不整合になる。**新規作成エントリぶんは FK cascade でたまたま
	// 消えていた**ため、既存エントリ経路だけがこの不具合の対象だった。
	it("既存エントリに足した試飲記録も取り消し、集計を元に戻す(#393)", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
			tasting: { drankOn: "2020-01-01", rating: 3 },
		});

		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 0,
			items: [
				// 既存エントリに「飲んだ」を付けて登録する
				{
					wine: undefined,
					existingId: existing.id,
					tasting: { drankOn: "2026-08-01", rating: 5 },
				},
			],
		});
		expect(result.drankCount).toBe(1);
		// 取り消し前は2件(元からの1件 + バッチが足した1件)
		expect(await listWineTastings(userId, existing.id)).toHaveLength(2);

		await undoImportBatch(userId, result.batchId);

		// バッチが足した試飲記録だけが消え、手動で足した過去の記録は残る
		const tastings = await listWineTastings(userId, existing.id);
		expect(tastings).toHaveLength(1);
		expect(tastings[0]).toMatchObject({ drankOn: "2020-01-01", rating: 3 });

		// 集計も元に戻る(ここが戻らないと一覧・詳細に取り消し前の値が残り続ける)
		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: existing.id,
			tastingCount: 1,
			lastDrankOn: "2020-01-01",
			lastRating: 3,
		});
	});

	// バッチ由来かどうかは wine_encounter.batch_id で判定する。取り消しが
	// 「そのエントリの体験記録を全部消す」実装に退化したらここで落ちる。
	it("取り消し後に手動で足した試飲記録は巻き込まない(#393)", async () => {
		const userId = await freshUser();
		// status を明示して「日付なしの飲用記録を1件作る」既定(finished)を避ける。
		// ここで見たいのは batch 由来かどうかの選別だけなので、雑音を入れない。
		const existing = await createDrunkWine(userId, {
			name: "既存エントリ",
			status: "spotted",
		});

		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: undefined,
					existingId: existing.id,
					tasting: { drankOn: "2026-08-01" },
				},
			],
		});
		// バッチとは無関係に、ユーザが自分で試飲記録を足す
		await addWineTasting(userId, existing.id, { drankOn: "2026-08-02" });

		await undoImportBatch(userId, result.batchId);

		const tastings = await listWineTastings(userId, existing.id);
		expect(tastings).toHaveLength(1);
		expect(tastings[0]).toMatchObject({ drankOn: "2026-08-02" });
	});

	it("新規作成エントリに足した試飲記録もエントリごと消える", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{ wine: { name: "新規のワイン" }, tasting: { drankOn: "2026-08-01" } },
			],
		});

		await undoImportBatch(userId, result.batchId);

		expect((await listDrunkWines(userId)).entries).toHaveLength(0);
		// 取り残された体験記録が無いこと(エントリが消えても行だけ残ると集計が壊れる)
		const leftover = await db
			.select()
			.from(wineEncounter)
			.where(eq(wineEncounter.userId, userId));
		expect(leftover).toHaveLength(0);
	});
});

describe("getImportBatch", () => {
	// 1x1 JPEG(マジックバイト検証を通る最小の実データ)
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	it("保存した写真URLを撮影順で返す(photoIndex の順と一致する)", async () => {
		// 順序が崩れると「別の写真で見かけたことになる」。再解析はこの順で写真を
		// 読み直して新バッチを作るので、ここが回帰防止の要になる。
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 2,
			items: [{ wine: { name: "順序の確認" }, sighting: { photoIndex: 1 } }],
		});
		const saved = await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		const batch = await getImportBatch(userId, result.batchId);

		expect(batch.photoUrls).toEqual(saved.photoUrls);
		expect(batch.photoUrls).toHaveLength(2);
		// 再解析は場所・見かけた日も引き継ぐ
		expect(batch.id).toBe(result.batchId);
	});

	it("場所と見かけた日を引き継げる形で返す", async () => {
		const userId = await freshUser();
		const shop = await createPlace(userId, { name: "やり直す店" });
		const result = await bulkRegisterFromScan(userId, {
			placeId: shop.id,
			seenOn: "2026-07-20",
			photoCount: 0,
			items: [{ wine: { name: "場所つき" } }],
		});

		const batch = await getImportBatch(userId, result.batchId);

		expect(batch.placeId).toBe(shop.id);
		expect(batch.seenOn).toBe("2026-07-20");
		expect(batch.photoUrls).toEqual([]);
	});

	it("他人のバッチは取得できない(404)", async () => {
		const userId = await freshUser();
		const stranger = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "他人のもの" } }],
		});

		await expect(
			getImportBatch(stranger, result.batchId),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe("getImportBatchDetail", () => {
	// 1x1 JPEG(マジックバイト検証を通る最小の実データ)
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);
	const jpeg = () => ({ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" });

	async function seedBatch(userId: string) {
		const shop = await createPlace(userId, { name: "詳細の店" });
		const existing = await createDrunkWine(userId, { name: "既存のワイン" });
		const result = await bulkRegisterFromScan(userId, {
			placeId: shop.id,
			seenOn: "2026-08-01",
			photoCount: 2,
			items: [
				{
					wine: {
						name: "新規のワイン",
						vintage: 2020,
						producer: "Dauvissat",
					},
					sighting: { photoIndex: 0, price: 24000 },
				},
				{
					existingId: existing.id,
					sighting: { photoIndex: 1, price: 9800 },
				},
			],
		});
		await saveImportBatchPhotos(userId, result.batchId, [jpeg(), jpeg()]);
		return result.batchId;
	}

	it("バッチ写真・新規銘柄・既存追加を分けて返す", async () => {
		const userId = await freshUser();
		const detail = await getImportBatchDetail(userId, await seedBatch(userId));

		expect(detail.placeName).toBe("詳細の店");
		expect(detail.seenOn).toBe("2026-08-01");
		expect(detail.photoUrls).toHaveLength(2);

		expect(detail.createdEntries).toHaveLength(1);
		const [created] = detail.createdEntries;
		expect(created).toMatchObject({
			name: "新規のワイン",
			vintage: 2020,
			producer: "Dauvissat",
		});
		// 新規銘柄はバッチ写真の複製を持つ(先頭=代表の規則は表示側と同じ)
		expect(created?.photoUrls.length).toBeGreaterThan(0);
		expect(created?.sighting).toMatchObject({
			placeName: "詳細の店",
			seenOn: "2026-08-01",
			price: 24000,
		});
		expect(created?.sighting?.photoUrl).toBeTruthy();

		expect(detail.matchedSightings).toHaveLength(1);
		expect(detail.matchedSightings[0]).toMatchObject({
			entryName: "既存のワイン",
			price: 9800,
			photoIndex: 1,
		});
		expect(detail.matchedSightings[0]?.photoUrl).toBeTruthy();
	});

	it("他人のバッチは取得できない(404)", async () => {
		const userId = await freshUser();
		const stranger = await freshUser();
		const batchId = await seedBatch(userId);

		await expect(
			getImportBatchDetail(stranger, batchId),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it("写真なし・既存追加のみのバッチも返す", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, { name: "既存のみ" });
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ existingId: existing.id, sighting: {} }],
		});

		const detail = await getImportBatchDetail(userId, result.batchId);

		expect(detail.photoUrls).toEqual([]);
		expect(detail.createdEntries).toEqual([]);
		expect(detail.matchedSightings).toHaveLength(1);
		expect(detail.matchedSightings[0]).toMatchObject({
			entryName: "既存のみ",
			photoUrl: null,
		});
	});
});

describe("listImportBatches", () => {
	it("新しい順に一覧し、場所名・件数・体験記録の内訳を含める", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, { name: "既存のワイン" });

		const first = await bulkRegisterFromScan(userId, {
			newPlace: { name: "1軒目" },
			seenOn: "2026-07-01",
			photoCount: 2,
			items: [
				{ wine: { name: "新規A" } },
				{ wine: undefined, existingId: existing.id },
			],
		});
		// bulkRegisterFromScan の photoCount は解析枚数の申告値で、バッチの実写真
		// (import_batch.photo_keys)は saveImportBatchPhotos(2段階目)まで空のまま
		await db
			.update(importBatch)
			.set({ createdAt: new Date(1000) })
			.where(eq(importBatch.id, first.batchId));

		const second = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "新規B" } }],
		});
		await db
			.update(importBatch)
			.set({ createdAt: new Date(2000) })
			.where(eq(importBatch.id, second.batchId));

		const batches = await listImportBatches(userId);
		expect(batches.map((b) => b.id)).toEqual([second.batchId, first.batchId]);

		expect(batches.find((b) => b.id === first.batchId)).toMatchObject({
			placeName: "1軒目",
			seenOn: "2026-07-01",
			photoCount: 0,
			photoUrls: [],
			createdCount: 1,
			matchedCount: 1,
			encounterCount: 2,
			hasEditedEntries: false,
		});
	});

	it("登録時に与えられた写真のURLを一覧に含める", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [
				{ wine: { name: "写真つきの一括登録" }, sighting: { photoIndex: 0 } },
			],
		});
		// 2段階目の保存前は写真が無いので空
		expect((await listImportBatches(userId))[0]?.photoUrls).toEqual([]);

		const jpeg1x1 = Uint8Array.from(
			atob(
				"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
			),
			(c) => c.charCodeAt(0),
		);
		await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: jpeg1x1, mimeType: "image/jpeg" },
		]);

		const [summary] = await listImportBatches(userId);
		expect(summary?.photoCount).toBe(1);
		expect(summary?.photoUrls).toHaveLength(1);
		// 一覧と再取得(getImportBatch)で同じURLを指す
		const batch = await getImportBatch(userId, result.batchId);
		expect(summary?.photoUrls).toEqual(batch.photoUrls);
	});

	it("登録後に編集された新規エントリは hasEditedEntries を立てる", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "後で編集される" } }],
		});
		const entryId = (await listDrunkWines(userId)).entries[0]?.id as string;
		// 実時間を待たずに「作成からしばらく経って更新された」状態を直接作る
		// (updatedAt の既定値と同じ式で作られる createdAt との差は通常 1ms 未満なので、
		// この閾値を跨がない限り実際の編集とは区別できる)
		await db
			.update(drunkWine)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(drunkWine.id, entryId));

		const [summary] = await listImportBatches(userId);
		expect(summary).toMatchObject({
			id: result.batchId,
			hasEditedEntries: true,
		});
	});

	it("全エントリが個別削除済みのバッチは0件のまま一覧に残る", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "後で個別削除される" } }],
		});
		const entryId = (await listDrunkWines(userId)).entries[0]?.id as string;
		await deleteDrunkWine(userId, entryId);

		const [summary] = await listImportBatches(userId);
		expect(summary).toMatchObject({
			id: result.batchId,
			createdCount: 0,
			encounterCount: 0,
		});
	});

	it("他ユーザのバッチは一覧に出ない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		await bulkRegisterFromScan(owner, {
			photoCount: 0,
			items: [{ wine: { name: "他人のバッチ" } }],
		});

		expect(await listImportBatches(stranger)).toEqual([]);
	});

	it("取り消したバッチは一覧から消える", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "取り消されるワイン" } }],
		});

		await undoImportBatch(userId, result.batchId);

		expect(await listImportBatches(userId)).toEqual([]);
	});
});

describe("saveImportBatchPhotos", () => {
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	async function seedBatch(userId: string): Promise<string> {
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [
				{ wine: { name: "写真つきの一括登録" }, sighting: { photoIndex: 0 } },
			],
		});
		return result.batchId;
	}

	it("バッチに1回だけ写真を置き、目撃記録の photoIndex が指す配列を確定する", async () => {
		const userId = await freshUser();
		const batchId = await seedBatch(userId);

		const batch = await saveImportBatchPhotos(userId, batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		expect(batch.photoUrls).toHaveLength(1);
		const key = imageKeyFromPath(batch.photoUrls[0] as string);
		// 認可・署名URL・退会時削除が前提にしている wines/{userId}/{中間ID}/ のレイアウト
		expect(key.startsWith(`wines/${userId}/${batchId}/`)).toBe(true);
		expect(await env.AVATARS.head(key)).not.toBeNull();
	});

	it("画像として認識できないファイルは保存しない(申告MIMEを信用しない #150)", async () => {
		const userId = await freshUser();
		const batchId = await seedBatch(userId);

		await expect(
			saveImportBatchPhotos(userId, batchId, [
				{
					bytes: new TextEncoder().encode("<html>not an image</html>"),
					mimeType: "image/jpeg",
				},
			]),
		).rejects.toBeInstanceOf(BadRequestError);
	});

	it("保存済みのバッチへの再アップロードは拒否する(photoIndex がずれるため)", async () => {
		const userId = await freshUser();
		const batchId = await seedBatch(userId);
		await saveImportBatchPhotos(userId, batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		await expect(
			saveImportBatchPhotos(userId, batchId, [
				{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow("保存済み");
	});

	it("他ユーザのバッチには保存できない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const batchId = await seedBatch(owner);

		await expect(
			saveImportBatchPhotos(stranger, batchId, [
				{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow("Import batch not found");
	});

	// Issue #405: 登録時の申告枚数(photoCount)は zod の検証にしか使われず永続化
	// されていなかったため、2段階目は「申告どおりの枚数が来たか」を確認できなかった。
	// 申告より少ない枚数が入ると、目撃記録の photoIndex が配列外(写真が出ない)か、
	// 前段が抜けた繰り上がりで**別の写真**を指す。
	describe("申告枚数との照合 (#405)", () => {
		/** photoIndex が 0,1,2 を指す3枚申告のバッチ。 */
		async function seedBatchOf3(userId: string): Promise<string> {
			const result = await bulkRegisterFromScan(userId, {
				photoCount: 3,
				items: [
					{ wine: { name: "1枚目のワイン" }, sighting: { photoIndex: 0 } },
					{ wine: { name: "2枚目のワイン" }, sighting: { photoIndex: 1 } },
					{ wine: { name: "3枚目のワイン" }, sighting: { photoIndex: 2 } },
				],
			});
			return result.batchId;
		}

		const jpeg = () => ({
			bytes: JPEG_1X1_BYTES,
			mimeType: "image/jpeg",
		});

		it("申告枚数を import_batch に残す", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			const [row] = await db
				.select({ photoCount: importBatch.photoCount })
				.from(importBatch)
				.where(eq(importBatch.id, batchId));
			expect(row?.photoCount).toBe(3);
		});

		it("申告より少ない枚数は拒否し、R2にも書かない", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			await expect(
				saveImportBatchPhotos(userId, batchId, [jpeg(), jpeg()]),
			).rejects.toBeInstanceOf(BadRequestError);

			// 拒否は R2 へ書く前に起きる(孤児オブジェクトを作らない)
			const objects = await env.AVATARS.list({
				prefix: `wines/${userId}/${batchId}/`,
			});
			expect(objects.objects).toHaveLength(0);
			// 写真キーも空のまま = やり直せる
			const [row] = await db
				.select({ photoKeys: importBatch.photoKeys })
				.from(importBatch)
				.where(eq(importBatch.id, batchId));
			expect(row?.photoKeys).toEqual([]);
		});

		it("申告より多い枚数も拒否する(順序がずれて別の写真を指すため)", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			await expect(
				saveImportBatchPhotos(userId, batchId, [
					jpeg(),
					jpeg(),
					jpeg(),
					jpeg(),
				]),
			).rejects.toBeInstanceOf(BadRequestError);
		});

		it("申告どおりの枚数なら通る", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			const batch = await saveImportBatchPhotos(userId, batchId, [
				jpeg(),
				jpeg(),
				jpeg(),
			]);
			expect(batch.photoUrls).toHaveLength(3);
		});

		it("申告枚数を持たない既存バッチ(photo_count=null)は照合をスキップする", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);
			// この列を持つ前に作られたバッチを再現する
			await db
				.update(importBatch)
				.set({ photoCount: null })
				.where(eq(importBatch.id, batchId));

			const batch = await saveImportBatchPhotos(userId, batchId, [jpeg()]);
			expect(batch.photoUrls).toHaveLength(1);
		});
	});
});
