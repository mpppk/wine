// 一括登録(import_batch)のサービス層。写真からのスキャンで抽出した複数銘柄を
// 1回の確定でまとめて登録する経路(Issue #358)。
//
// drunk-wine-service.ts から機械的に切り出したもの(Issue #406)。分離基準は
// place-service.ts:8-13 に準拠する: place が「drunk_wine と結合しない独立した
// マスタ」として分けられたのに対し、import-batch は drunk_wine / wine_encounter と
// 同じ db.batch に積む必要があり、結合点のヘルパは drunk-wine-service から
// import する(recomputeDrunkWineAggregatesBulk / cleanupPhotoObjects /
// buildEncounterValues(旧 buildSightingValues)ほか)。挙動変更なしの純移動。

import { env } from "cloudflare:workers";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine, importBatch, place, wineEncounter } from "#/db/schema";
import type { LabelPrice, LabelReferenceLink } from "#/lib/ai/label-extraction";
import {
	type PhotoKind,
	resolveStoredPhotoKinds,
} from "#/lib/ai/wine-list-extraction";
import { appendWineNote, NOTE_SECTION_LABELS } from "#/lib/drunk-wine/note";
import {
	buildWinePhotoKey,
	MAX_PHOTOS_PER_ENTRY,
	photoExtForMime,
	resolveStoredPhotoMime,
	thumbKeyForPhotoKey,
} from "#/lib/drunk-wine/photo";
import {
	mergeStoredMarketPrices,
	mergeStoredReferenceLinks,
	normalizeStoredMarketPrices,
	normalizeStoredReferenceLinks,
} from "#/lib/drunk-wine/references";
import type { WineStatus } from "#/lib/drunk-wine/status";
import { BadRequestError, ConflictError, NotFoundError } from "#/lib/errors";
import { fetchRemotePhoto } from "#/lib/images/remote-photo";
import { imagePathForKey } from "#/lib/images/signed-url";
import {
	type BulkRegisterFromScanInput,
	MAX_WEB_PHOTOS_PER_IMPORT,
} from "#/lib/import-batch/schema";
import { logInfo, logWarn } from "#/lib/logger";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import {
	assertOwnsEncounterRefs,
	assertValidRefs,
	type BatchStatement,
	buildEncounterValues,
	cleanupPhotoObjects,
	encounterPhotoIndexes,
	provenanceInsertValues,
	recomputeDrunkWineAggregatesBulk,
	toSightingEntry,
} from "#/lib/services/drunk-wine-service";
import { prepareNewPlace } from "#/lib/services/place-service";

/**
 * 既に R2 にある写真キーを一括登録バッチへ渡す(#474)。エントリ側の
 * `appendDrunkWinePhotoKeys` と同じ役割で、宛先がバッチになったもの。
 *
 * 一括抽出はジョブ経路(#474)なので、**投入の時点で写真はサーバ(R2)に載っている**。
 * 手元に `File` があるかどうかに関わらず、バッチはその実体を引き継ぐだけでよい
 * (レビュー画面へ戻ってきた利用者の手元に `File` が無い回は、そもそも送り直せない)。
 *
 * 排他・申告枚数の照合・銘柄への複製は `attachImportBatchPhotoKeys`(バッチに写真が
 * 載る唯一の関門)が持つ。ここで条件を書き足さないこと——アップロード経路とこちらで
 * 条件がドリフトした結果が #617 だった。
 */
export async function adoptImportBatchPhotoKeys(
	userId: string,
	batchId: string,
	keys: string[],
): Promise<{ adopted: string[]; dropped: string[] }> {
	// 上限を超えるぶんは足さずに捨てる(引き継ぎは付随的な処理で、ここで例外にすると
	// 「登録は出来たのに写真のせいで失敗した」ことになる)。捨てたキーは呼び出し側が掃除する。
	const adopted = keys.slice(0, MAX_PHOTOS_PER_IMPORT_BATCH);
	const dropped = keys.slice(MAX_PHOTOS_PER_IMPORT_BATCH);
	if (adopted.length > 0) {
		await attachImportBatchPhotoKeys(userId, batchId, adopted);
	}
	return { adopted, dropped };
}

// ---- 一括登録(写真からのスキャン。Issue #358) -----------------------------
// レストランのワインリスト・ショップの棚を撮った写真から抽出した複数銘柄を、
// 1回の確定でまとめて登録する経路。場所(新規なら)・バッチ・銘柄・体験記録・
// 集計キャッシュを**すべて同一の db.batch で原子的に**作る。
//
// drunk_wine / wine_encounter と同じ db.batch に積むため、集計・値組み立て・
// R2掃除のヘルパは drunk-wine-service から import する
// (recomputeDrunkWineAggregatesBulk / buildEncounterValues /
// cleanupPhotoObjects ほか。Issue #406 の結合点)。
//
// 写真の実体だけは2段階目(saveImportBatchPhotos)になる。R2キーが batchId 依存で、
// バッチ行が確定するまでキーを採番できないため(エントリ写真と同じ制約)。

export interface BulkRegisterFromScanResult {
	/** 作成した一括登録バッチのID。写真アップロード(2段階目)がこれを使う */
	batchId: string;
	/** 紐付けた場所のID。場所を指定しなかった場合は null */
	placeId: string | null;
	/** 新規作成した銘柄の件数 */
	createdCount: number;
	/** 既存エントリに体験記録だけを足した件数 */
	matchedCount: number;
	/** 作成した体験記録の件数(= items の件数) */
	encounterCount: number;
	/** うち「飲んだ」指定で drank=1 になった件数 */
	drankCount: number;
}

/**
 * 写真から抽出した銘柄群をまとめて登録する。
 *
 * - `existingId` の項目は銘柄を作らず、その既存エントリに体験記録だけを足す
 *   (同じワインを別の店でも見かけた、を1エントリ + 体験N件で表す設計)
 * - 体験記録の場所・出会った日・バッチIDはバッチ共通の値をここで埋める
 * - `status` 未指定の新規銘柄は "spotted"(見かけた)。createDrunkWine の既定
 *   (finished)をそのまま使うと、見かけただけのワインが飲み終わり扱いになり、
 *   日付なしの飲用記録まで作られてしまう
 *
 * **全成功か全失敗**なので、ネットワーク都合で再送されても部分的な重複は残らない
 * (同じ入力をユーザが2回確定すれば2バッチできるが、それは意図した操作)。
 */
/**
 * web から取り込んだ銘柄写真(#473)。R2 へ書いた後・D1 へ書く前の中間状態。
 * `noteSuffix` は「画像と実物のズレ」の注記で、**取り込めた銘柄にだけ**付く。
 */
interface AdoptedWebPhoto {
	photoKey: string;
	noteSuffix?: string;
}

/** web 写真の同時取得数。外部サイト相手なので直列だと遅く、無制限だと詰まる。 */
const WEB_PHOTO_FETCH_CONCURRENCY = 4;

/**
 * 一括登録の各銘柄について、解析が見つけた web 画像を取り込んで R2 に置く(#473)。
 * キーは呼び出し側が採番済みの `drunkWineId` に紐づくので、**エントリの INSERT より前**に
 * 呼んで、返ったキーを `photo_keys` に載せる。
 *
 * **失敗は握りつぶす**。写真が取れなかった銘柄は `saveImportBatchPhotos` が一括登録の
 * 写真へ退避する(要件の3段目)ので、ここで例外にすると「写真のせいで登録が失敗する」
 * ことになる。取得の検証(https のみ・実バイトのMIME判定・サイズ上限)は
 * `fetchRemotePhoto` が単一の関門として行う。
 *
 * 件数は `MAX_WEB_PHOTOS_PER_IMPORT` で打ち切る。80銘柄ぶんの外部取得を確定操作の
 * 中に積むと、登録が外部サイトの応答時間に引きずられるため。
 */
async function adoptWebPhotos(
	userId: string,
	requests: { drunkWineId: string; url: string; note?: string }[],
): Promise<Map<string, AdoptedWebPhoto>> {
	const adopted = new Map<string, AdoptedWebPhoto>();
	const targets = requests.slice(0, MAX_WEB_PHOTOS_PER_IMPORT);
	for (let i = 0; i < targets.length; i += WEB_PHOTO_FETCH_CONCURRENCY) {
		const chunk = targets.slice(i, i + WEB_PHOTO_FETCH_CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async (request) => {
				const photo = await fetchRemotePhoto(request.url, {
					userId,
					drunkWineId: request.drunkWineId,
				});
				if (!photo) return undefined;
				const key = buildWinePhotoKey(
					userId,
					request.drunkWineId,
					crypto.randomUUID(),
					photo.mimeType,
				);
				try {
					await env.AVATARS.put(key, photo.bytes, {
						httpMetadata: { contentType: photo.mimeType },
					});
				} catch (err) {
					logWarn("web photo store failed", {
						userId,
						drunkWineId: request.drunkWineId,
						err,
					});
					return undefined;
				}
				return { drunkWineId: request.drunkWineId, key, note: request.note };
			}),
		);
		for (const result of results) {
			if (!result) continue;
			adopted.set(result.drunkWineId, {
				photoKey: result.key,
				...(result.note ? { noteSuffix: result.note } : {}),
			});
		}
	}
	return adopted;
}

export async function bulkRegisterFromScan(
	userId: string,
	input: BulkRegisterFromScanInput,
): Promise<BulkRegisterFromScanResult> {
	// 静的マスタ(AOP・品種)の検証は新規銘柄ぶんだけ。1件でも不正なら登録全体を
	// 断る(部分適用にすると、どれが入ってどれが入らなかったかを画面が説明できない)
	for (const item of input.items) {
		if (item.wine) assertValidRefs(item.wine);
	}

	// 既存エントリの所有権をまとめて確認する。1件ずつ SELECT すると件数ぶん
	// ラウンドトリップが増えるので、id の集合で1回引いて差分を見る。
	const existingIds = [
		...new Set(
			input.items
				.map((i) => i.existingId)
				.filter((id): id is string => id != null),
		),
	];
	// 既存一致の項目へ参考情報をマージするための現在値。所有権確認のついでに引く。
	const existingReferences = new Map<
		string,
		{ referenceLinks: LabelReferenceLink[]; prices: LabelPrice[] }
	>();
	if (existingIds.length > 0) {
		const rows = await db
			.select({
				id: drunkWine.id,
				referenceLinks: drunkWine.referenceLinks,
				marketPrices: drunkWine.marketPrices,
			})
			.from(drunkWine)
			.where(
				and(eq(drunkWine.userId, userId), inArray(drunkWine.id, existingIds)),
			);
		if (rows.length !== existingIds.length) {
			// 存在しない/他ユーザ所有は区別しない(存在の探索を防ぐ規約)
			throw new NotFoundError("Entry not found");
		}
		for (const row of rows) {
			existingReferences.set(row.id, {
				referenceLinks: normalizeStoredReferenceLinks(row.referenceLinks),
				prices: normalizeStoredMarketPrices(row.marketPrices),
			});
		}
	}

	// 場所: 既存の指定は所有権を確認し、新規は同じ batch で作る
	if (input.placeId) {
		await assertOwnsEncounterRefs(userId, { placeId: input.placeId });
	}
	const newPlace = input.newPlace
		? await prepareNewPlace(userId, input.newPlace)
		: null;
	const placeId = input.placeId ?? newPlace?.id ?? null;

	const batchId = crypto.randomUUID();
	const statements: BatchStatement[] = [];

	// 新規銘柄の id を**先に**採番する(#473)。web 写真の R2 キーがエントリIDに紐づく
	// ため、INSERT を組み立てる前に id が要る。
	const newWineIds = new Map<number, string>();
	for (const [index, item] of input.items.entries()) {
		if (item.wine) newWineIds.set(index, crypto.randomUUID());
	}
	// 解析が見つけた web 画像を取り込む。D1 へ書く前に済ませて、取れたぶんだけ
	// photo_keys に載せる(取れなかった銘柄は2段階目でバッチ写真へ退避する)。
	const webPhotos = await adoptWebPhotos(
		userId,
		input.items.flatMap((item, index) => {
			const drunkWineId = newWineIds.get(index);
			if (!drunkWineId || !item.wine || !item.webPhoto) return [];
			return [
				{
					drunkWineId,
					url: item.webPhoto.url,
					...(item.webPhoto.note ? { note: item.webPhoto.note } : {}),
				},
			];
		}),
	);

	if (newPlace) {
		statements.push(db.insert(place).values(newPlace));
	}

	statements.push(
		db.insert(importBatch).values({
			id: batchId,
			userId,
			placeId,
			seenOn: input.seenOn ?? null,
			// 写真の実体は2段階目(saveImportBatchPhotos)で入る。申告枚数はここで
			// 残しておく——2段階目が「申告どおりの枚数が来たか」を確認する唯一の
			// 手掛かりで、捨てると photoIndex の指す先を保証できない(#405)。
			photoKeys: [],
			photoCount: input.photoCount,
		}),
	);

	const affectedIds: string[] = [];
	let createdCount = 0;
	let drankCount = 0;
	for (const [index, item] of input.items.entries()) {
		let drunkWineId: string;
		if (item.wine) {
			drunkWineId = newWineIds.get(index) as string;
			createdCount += 1;
			const webPhoto = webPhotos.get(drunkWineId);
			statements.push(
				db.insert(drunkWine).values({
					id: drunkWineId,
					userId,
					name: item.wine.name,
					// 見かけただけ、が既定。飲んだかどうかは tasting の有無で表す
					status: item.wine.status ?? "spotted",
					...provenanceInsertValues(item.wine),
					vintage: item.wine.vintage ?? null,
					grapeVarietyIds: item.wine.grapeVarietyIds ?? [],
					producer: item.wine.producer ?? null,
					// 取り込んだ画像が別ヴィンテージ等なら、その旨をコメントへ追記する
					// (#473)。**取り込めたときだけ**追記する——画像が無いのに
					// 「写真は2019年のものです」だけ残ると意味が通らない。
					note: appendWineNote(
						item.wine.note,
						webPhoto?.noteSuffix
							? `${NOTE_SECTION_LABELS.photo}\n${webPhoto.noteSuffix}`
							: undefined,
					),
					// 参考サイト・市場価格は銘柄に属するのでそのまま保存する。
					referenceLinks: normalizeStoredReferenceLinks(item.referenceLinks),
					marketPrices: normalizeStoredMarketPrices(item.prices),
					// adoptWebPhotos で取り込めた写真は web 由来。取れなかった銘柄は
					// photo_keys を持たず、2段階目でバッチ写真の複製(bottle)が付く。
					...(webPhoto
						? {
								photoKeys: [webPhoto.photoKey],
								photoKinds: ["web" as PhotoKind],
							}
						: {}),
					// このバッチで新規作成したエントリだけに付ける(Issue #363 案A)。
					// 既存一致(item.existingId)はエントリを作らないので付けない
					// (足されるのは体験記録(drank=0 と、指定があれば drank=1)。
					//  どちらもそれぞれの batch_id で辿れる)。
					batchId,
				}),
			);
		} else {
			// refine 済みなので existingId は必ずある
			drunkWineId = item.existingId as string;
			// 既存一致の項目は目撃記録を足すだけだが、参考情報の未保存ぶんは
			// マージする(上書きではなく和集合。上限で切り捨て)。
			const newLinks = normalizeStoredReferenceLinks(item.referenceLinks);
			const newPrices = normalizeStoredMarketPrices(item.prices);
			if (newLinks.length > 0 || newPrices.length > 0) {
				const current = existingReferences.get(drunkWineId);
				statements.push(
					db
						.update(drunkWine)
						.set({
							...(newLinks.length > 0
								? {
										referenceLinks:
											mergeStoredReferenceLinks(
												current?.referenceLinks,
												newLinks,
											) ?? [],
									}
								: {}),
							...(newPrices.length > 0
								? {
										marketPrices:
											mergeStoredMarketPrices(current?.prices, newPrices) ?? [],
									}
								: {}),
						})
						.where(
							and(eq(drunkWine.id, drunkWineId), eq(drunkWine.userId, userId)),
						),
				);
			}
		}
		affectedIds.push(drunkWineId);

		// 項目ごとに体験記録を1件作る。「飲んだ」指定があれば drank=1、無ければ
		// drank=0——旧2テーブル体制では2行だったものが、統合で1行になる。
		// 日付は飲んだ日の指定があればそちら、無ければバッチ共通の見かけた日。
		//
		// **batchId を必ず付ける**(#393)。既存エントリに足した体験記録も
		// 取り消しの対象にするための唯一の手掛かり。
		statements.push(
			db.insert(wineEncounter).values(
				buildEncounterValues(userId, drunkWineId, {
					drank: item.tasting != null,
					occurredOn: item.tasting?.drankOn ?? input.seenOn,
					rating: item.tasting?.rating,
					price: item.sighting?.price,
					memo: item.tasting?.memo ?? item.sighting?.memo,
					placeId: placeId ?? undefined,
					batchId,
					photoIndex: item.sighting?.photoIndex,
					photoIndexes: item.sighting?.photoIndexes,
				}),
			),
		);

		if (item.tasting) drankCount += 1;
	}

	// 集計キャッシュは INSERT 群の後に積む(D1 の batch は順次実行なので、この
	// UPDATE は同じ batch の INSERT の結果を見る)。新規銘柄も既存銘柄も対象。
	statements.push(...recomputeDrunkWineAggregatesBulk(userId, affectedIds));

	// items は1件以上(zod)なので statements も必ず1件以上になる
	try {
		await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
	} catch (e) {
		// D1 が全失敗したら、先に R2 へ置いた web 写真は誰からも参照されない孤児になる
		// (#473)。エントリ写真の保存経路(syncDrunkWinePhotos)と同じく、巻き戻しの
		// 成否に関わらず元例外を投げる(掃除の失敗で真因を隠さない)。
		await cleanupPhotoObjects(
			[...webPhotos.values()].map((p) => p.photoKey),
			{
				userId,
				entryId: batchId,
				phase: "bulk-register-rollback",
				originalErr: e,
			},
		);
		throw e;
	}

	return {
		batchId,
		placeId,
		createdCount,
		matchedCount: input.items.length - createdCount,
		encounterCount: input.items.length,
		drankCount,
	};
}

/**
 * 一括登録バッチの取り消し(Issue #363 案A)。
 *
 * **登録直後の完了導線からのみ呼ばれる、という前提はもう成立しない**。#385 が
 * 一括登録の履歴画面(`/cellar/import/history`)から**恒常的に**取り消せるようにした
 * ため、「取り消しが呼ばれる時点で他の操作が挟まっていない」とは限らない
 * (この JSDoc は以前その前提で「登録後にユーザが編集した銘柄をどう扱うか」の論点を
 * 回避していると書いていたが、実態と乖離していた。#393)。編集済みエントリの扱いは
 * 未決の論点のままで、現状の防波堤はクライアント側の確認ダイアログの警告だけ
 * (`ImportBatchSummary.hasEditedEntries` が材料)。サーバ側は無条件に削除する。
 *
 * 削除対象は **このバッチで新規作成されたエントリ**(drunk_wine.batch_id が
 * このバッチのもの)のみ。「既存エントリに体験記録が増えただけ」のものは
 * エントリを消さず、体験記録だけを取り消して集計を再計算する(バッチと
 * 無関係な過去のデータを失わないため、issue本文の案Aの要点)。
 *
 * **体験記録はバッチ由来のものだけ消す**(#393)。一括登録は既存エントリにも
 * 飲用記録(drank=1 の体験記録)を足せる(「このワインを飲んだ」)ため、これを
 * 消さないと取り消しても tasting_count / last_drank_on / last_rating が戻らない。
 * 新規作成エントリぶんはエントリ削除の FK cascade でも消えるが、
 * **既存エントリに足したぶんは wine_encounter.batch_id を辿らないと特定できない**。
 * ユーザが手動で足した体験記録は batch_id が null なので巻き込まない。
 *
 * バッチが作った place は消さない(参照が無くなっても場所マスタとして残す。
 * 不要ならユーザが deletePlace で個別に消せる)。バッチ写真
 * (import_batch.photo_keys)はエントリ写真とは別物でどの削除経路も掃除しない
 * ため、ここで明示的に消す(サムネイルは保存していないので thumb 分は不要)。
 */
export async function undoImportBatch(
	userId: string,
	batchId: string,
): Promise<{ deletedCount: number }> {
	const [batch] = await db
		.select({ photoKeys: importBatch.photoKeys })
		.from(importBatch)
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!batch) throw new NotFoundError("Batch not found");

	const createdRows = await db
		.select({ id: drunkWine.id, photoKeys: drunkWine.photoKeys })
		.from(drunkWine)
		.where(and(eq(drunkWine.batchId, batchId), eq(drunkWine.userId, userId)));
	const createdIds = new Set(createdRows.map((row) => row.id));

	// バッチが足した体験記録の付き先を拾う。1項目=1行(drank は指定次第)なので、
	// drank で分けず batch_id でまとめて拾う。**集計の再計算漏れは「取り消したのに数値が戻らない」という形で
	// 表に出る**ので、付き先は体験記録全体から集める。
	const encounterRows = await db
		.select({
			drunkWineId: wineEncounter.drunkWineId,
			drank: wineEncounter.drank,
		})
		.from(wineEncounter)
		.where(
			and(eq(wineEncounter.batchId, batchId), eq(wineEncounter.userId, userId)),
		);
	// 新規作成エントリ以外(=既存エントリに記録が増えただけ)は、削除後に集計
	// (encounterCount/lastEncounteredOn/tastingCount/lastDrankOn/lastRating)を再計算する。
	// 新規作成エントリはエントリごと消えるので再計算は要らない。
	const touchedExistingIds = [
		...new Set(
			encounterRows
				.map((row) => row.drunkWineId)
				.filter((id) => !createdIds.has(id)),
		),
	];

	const statements: BatchStatement[] = [
		// バッチ由来の体験記録(batch_id 一致)だけを消す。手動で足したものは
		// batch_id が null なので残る。**エントリ削除より前に置く**必要は無いが、
		// 削除対象の集合は batch_id で決まるので順序に依存しない。
		db
			.delete(wineEncounter)
			.where(
				and(
					eq(wineEncounter.batchId, batchId),
					eq(wineEncounter.userId, userId),
				),
			),
		db
			.delete(drunkWine)
			.where(and(eq(drunkWine.batchId, batchId), eq(drunkWine.userId, userId))),
	];
	if (touchedExistingIds.length > 0) {
		statements.push(
			...recomputeDrunkWineAggregatesBulk(userId, touchedExistingIds),
		);
	}
	statements.push(
		db
			.delete(importBatch)
			.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId))),
	);
	await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

	// D1の書き込みは既に確定しているので、R2掃除の失敗で「取り消せなかった」とは返さない(#249と同じ扱い)。
	const entryPhotoKeys = createdRows.flatMap((row) =>
		row.photoKeys.length > 0
			? [...row.photoKeys, ...row.photoKeys.map(thumbKeyForPhotoKey)]
			: [],
	);
	const photoKeys = [...batch.photoKeys, ...entryPhotoKeys];
	await cleanupPhotoObjects(photoKeys, {
		userId,
		entryId: batchId,
		phase: "import-batch-undone",
	});

	// 取り消しの監査ライン(#394)。3テーブル(cascade 込み)とR2写真に及ぶ不可逆の操作
	// なので、成功も1行残す。**再構成の手段が無い**ため、後から「何がどれだけ消えたか」を
	// 知る唯一の手掛かりになる。recomputedCount は「既存エントリから記録だけを取り消した」
	// 件数で、deletedCount(このバッチで作られて消えたエントリ)とは別物。
	logInfo("import batch undone", {
		userId,
		batchId,
		deletedCount: createdRows.length,
		encounterCount: encounterRows.length,
		drankCount: encounterRows.filter((row) => row.drank).length,
		recomputedCount: touchedExistingIds.length,
		photoKeyCount: photoKeys.length,
	});

	return { deletedCount: createdRows.length };
}

/** 一括登録バッチ履歴の一覧に返す1件。 */
export interface ImportBatchSummary {
	id: string;
	placeId: string | null;
	placeName: string | null;
	/** 見かけた日 "YYYY-MM-DD" */
	seenOn: string | null;
	photoCount: number;
	/**
	 * 登録時に与えられた写真の相対URL(/api/images/... 撮影順)。
	 * 一覧の各アイテムにサムネイルとして出すために返す(詳細と同じURL)。
	 * バッチ写真にサムネイル版は作らないので、原寸URLをそのまま使う
	 * (無いぶんは配信ルートが原寸へフォールバックする)。
	 */
	photoUrls: string[];
	createdAt: number;
	/** このバッチで新規作成されたエントリの件数 */
	createdCount: number;
	/** 既存エントリに体験記録を追加しただけの件数(encounterCount - createdCount) */
	matchedCount: number;
	/** 体験記録の総数(createdCount + matchedCount) */
	encounterCount: number;
	/**
	 * 新規作成エントリのいずれかが登録後に編集されている(updatedAt が createdAt より
	 * 1秒以上後。同一INSERT文内の誤差を編集扱いしないための閾値)。取り消すと編集内容も
	 * 失われるため、一覧・確認ダイアログで警告する材料に使う(Issue #380 の未確定の論点)。
	 */
	hasEditedEntries: boolean;
}

const IMPORT_BATCH_HISTORY_LIMIT = 50;

/**
 * 過去の一括登録バッチを新しい順に一覧する(Issue #380)。#378 は取り消し導線を
 * 登録直後の完了画面だけに限定したため件数の集計を持たなかったが、ここでは
 * バッチ一覧画面から後からでも取り消せるようにするため、drunk_wine /
 * wine_encounter を都度集計する(import_batch 自体には件数列を持たせない)。
 *
 * 全エントリが個別削除済みのバッチ(#380 未確定論点の1つ)は特別扱いしない。
 * createdCount/encounterCount が0のまま一覧に出て、取り消しは
 * undoImportBatch が対象0件のまま成功しバッチ行だけを消す(害が無い)。
 */
export async function listImportBatches(
	userId: string,
): Promise<ImportBatchSummary[]> {
	const batches = await db
		.select({
			id: importBatch.id,
			placeId: importBatch.placeId,
			placeName: place.name,
			seenOn: importBatch.seenOn,
			photoKeys: importBatch.photoKeys,
			createdAt: importBatch.createdAt,
		})
		.from(importBatch)
		.leftJoin(place, eq(place.id, importBatch.placeId))
		.where(eq(importBatch.userId, userId))
		.orderBy(desc(importBatch.createdAt))
		.limit(IMPORT_BATCH_HISTORY_LIMIT);
	if (batches.length === 0) return [];

	const ids = batches.map((b) => b.id);
	const [createdStats, encounterStats] = await Promise.all([
		db
			.select({
				batchId: drunkWine.batchId,
				createdCount: sql<number>`count(*)`,
				editedCount: sql<number>`sum(case when ${drunkWine.updatedAt} > ${drunkWine.createdAt} + 1000 then 1 else 0 end)`,
			})
			.from(drunkWine)
			.where(and(eq(drunkWine.userId, userId), inArray(drunkWine.batchId, ids)))
			.groupBy(drunkWine.batchId),
		// 項目ごとに体験記録が1件ずつある(1行化した統合後は drank によらず
		// 1項目=1行)ので、絞らず数えると items 件数と同じ値になる。
		db
			.select({
				batchId: wineEncounter.batchId,
				encounterCount: sql<number>`count(*)`,
			})
			.from(wineEncounter)
			.where(
				and(
					eq(wineEncounter.userId, userId),
					inArray(wineEncounter.batchId, ids),
				),
			)
			.groupBy(wineEncounter.batchId),
	]);

	const createdByBatch = new Map(
		createdStats
			.filter((r): r is typeof r & { batchId: string } => r.batchId != null)
			.map((r) => [r.batchId, r]),
	);
	const encounterByBatch = new Map(
		encounterStats
			.filter((r): r is typeof r & { batchId: string } => r.batchId != null)
			.map((r) => [r.batchId, Number(r.encounterCount)]),
	);

	return batches.map((b) => {
		const created = createdByBatch.get(b.id);
		const createdCount = Number(created?.createdCount ?? 0);
		const encounterCount = encounterByBatch.get(b.id) ?? 0;
		return {
			id: b.id,
			placeId: b.placeId,
			placeName: b.placeName,
			seenOn: b.seenOn,
			photoCount: b.photoKeys.length,
			photoUrls: b.photoKeys.map(imagePathForKey),
			createdAt: b.createdAt.getTime(),
			createdCount,
			matchedCount: Math.max(0, encounterCount - createdCount),
			encounterCount,
			hasEditedEntries: Number(created?.editedCount ?? 0) > 0,
		};
	});
}

/** 一括登録バッチ1件(写真アップロードの応答)。 */
export interface ImportBatchEntry {
	id: string;
	placeId: string | null;
	seenOn: string | null;
	/** 写真の相対URL(/api/images/...)。撮影順 = 目撃記録の photoIndex が指す順 */
	photoUrls: string[];
	createdAt: number;
}

function toImportBatchEntry(
	row: typeof importBatch.$inferSelect,
): ImportBatchEntry {
	return {
		id: row.id,
		placeId: row.placeId,
		seenOn: row.seenOn,
		photoUrls: row.photoKeys.map(imagePathForKey),
		createdAt: row.createdAt.getTime(),
	};
}

/**
 * 一括登録バッチ1件を取り出す(本人所有のみ)。履歴からの再解析(#427)が、
 * 保存済みの写真URLと当時の場所・見かけた日を読み直すために使う。
 *
 * 写真URLは `/api/images/wines/...` の相対URLで、**本人セッションの same-origin
 * 取得で読める**(署名URLは要らない。images/signed-url.ts の認可経路1)。
 * 再解析はアプリ内のログイン済み画面から走るので、クライアントがこのURLを
 * fetch して解析用に縮小できる。
 */
export async function getImportBatch(
	userId: string,
	batchId: string,
): Promise<ImportBatchEntry> {
	const [row] = await db
		.select()
		.from(importBatch)
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!row) throw new NotFoundError("Import batch not found");
	return toImportBatchEntry(row);
}

/** バッチ詳細の新規作成銘柄1件。保存された値と写真をそのまま出す(読み取り専用)。 */
interface ImportBatchDetailCreatedEntry {
	id: string;
	name: string;
	status: WineStatus;
	vintage: number | null;
	producer: string | null;
	note: string | null;
	/** 原寸の相対URL(表示順・先頭=代表)。wine-1 の代表規則と同じ */
	photoUrls: string[];
	thumbUrls: string[];
	photoKinds: PhotoKind[];
	createdAt: number;
	/**
	 * 写真のキャッシュバスタ。バッチ後に写真を足し直すと R2 キーが同じでも
	 * 中身が変わるため、バッチの時刻ではなくエントリの更新時刻を使う。
	 */
	updatedAt: number;
	/** このバッチで付けた体験記録(場所・価格・写真)。銘柄1件に1件だけある */
	sighting: {
		drank: boolean;
		rating: number | null;
		placeName: string | null;
		seenOn: string | null;
		price: number | null;
		memo: string | null;
		photoUrl: string | null;
		/** そのワインが写っていた写真の相対URLの一覧(#574) */
		photoUrls: string[];
	} | null;
}

/** バッチ詳細の既存追加ぶん1件(体験記録)。銘柄は作らず、足した記録だけ出す。 */
interface ImportBatchDetailMatchedSighting {
	id: string;
	entryId: string;
	/** 対象銘柄の名前。削除済みなら null(「削除済みの銘柄」と出す) */
	entryName: string | null;
	drank: boolean;
	rating: number | null;
	placeName: string | null;
	seenOn: string | null;
	price: number | null;
	memo: string | null;
	photoUrl: string | null;
	/** そのワインが写っていた写真の相対URLの一覧(#574) */
	photoUrls: string[];
	photoIndex: number | null;
}

/** 一括登録バッチ1件の詳細。履歴画面からの遷移先。読み取り専用で件数は数えない。 */
export interface ImportBatchDetail {
	id: string;
	placeName: string | null;
	seenOn: string | null;
	/** バッチ写真の相対URL(撮影順 = 目撃記録の photoIndex が指す順) */
	photoUrls: string[];
	createdAt: number;
	createdEntries: ImportBatchDetailCreatedEntry[];
	matchedSightings: ImportBatchDetailMatchedSighting[];
}

function toBatchDetailEntry(
	row: typeof drunkWine.$inferSelect,
): Omit<ImportBatchDetailCreatedEntry, "sighting"> {
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		vintage: row.vintage,
		producer: row.producer,
		note: row.note,
		photoUrls: row.photoKeys.map(imagePathForKey),
		thumbUrls: row.photoKeys.map((key) =>
			imagePathForKey(thumbKeyForPhotoKey(key)),
		),
		photoKinds: resolveStoredPhotoKinds(row.photoKeys, row.photoKinds),
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * 一括登録バッチ1件の詳細を返す(本人所有のみ)。履歴の行から「どんな写真が
 * アップロードされたか、どんな値が設定されたか」を辿るための読み取り専用口で、
 * 分析完了後の一覧(レビューカード)と同等の項目を、保存済みの値から組み立てる。
 *
 * - 他人のバッチ・存在しないIDは `getImportBatch` と同じく 404(存在を漏らさない)
 * - 新規作成した銘柄は保存値と写真と、そのバッチで付けた体験記録(drank=0)を添える
 * - 既存一致ぶんは銘柄を作っていないので、足した体験記録(drank=0)だけを出す
 * - 参考サイト・価格の一覧は保存していない(IMPL-3 はジョブ結果JSONにだけ
 *   載る)ため、ここには出ない
 */
export async function getImportBatchDetail(
	userId: string,
	batchId: string,
): Promise<ImportBatchDetail> {
	const [batchRow] = await db
		.select({ batch: importBatch, placeName: place.name })
		.from(importBatch)
		.leftJoin(place, eq(place.id, importBatch.placeId))
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!batchRow) throw new NotFoundError("Import batch not found");

	const entryRows = await db
		.select()
		.from(drunkWine)
		.where(and(eq(drunkWine.batchId, batchId), eq(drunkWine.userId, userId)))
		.orderBy(desc(drunkWine.createdAt));
	// 項目ごとに体験記録が1件ずつある(1行化した統合後は drank によらず
	// 1項目=1行)ので、絞らずに拾う。
	const sightingRows = await db
		.select({
			...getTableColumns(wineEncounter),
			placeName: place.name,
			batchPhotoKeys: importBatch.photoKeys,
			entryName: drunkWine.name,
		})
		.from(wineEncounter)
		.leftJoin(place, eq(place.id, wineEncounter.placeId))
		.leftJoin(importBatch, eq(importBatch.id, wineEncounter.batchId))
		.leftJoin(
			drunkWine,
			and(
				eq(drunkWine.id, wineEncounter.drunkWineId),
				eq(drunkWine.userId, userId),
			),
		)
		.where(
			and(eq(wineEncounter.batchId, batchId), eq(wineEncounter.userId, userId)),
		)
		.orderBy(desc(wineEncounter.createdAt));

	const createdIds = new Set(entryRows.map((row) => row.id));
	const sightingByEntry = new Map<
		string,
		{
			drank: boolean;
			rating: number | null;
			placeName: string | null;
			seenOn: string | null;
			price: number | null;
			memo: string | null;
			photoUrl: string | null;
			photoUrls: string[];
		}
	>();
	const matchedSightings: ImportBatchDetailMatchedSighting[] = [];
	for (const row of sightingRows) {
		const sighting = toSightingEntry(row);
		if (createdIds.has(row.drunkWineId)) {
			sightingByEntry.set(row.drunkWineId, {
				drank: row.drank,
				rating: row.rating,
				placeName: sighting.placeName,
				seenOn: sighting.seenOn,
				price: sighting.price,
				memo: sighting.memo,
				photoUrl: sighting.photoUrl,
				photoUrls: sighting.photoUrls,
			});
		} else {
			matchedSightings.push({
				id: sighting.id,
				entryId: row.drunkWineId,
				entryName: row.entryName,
				drank: row.drank,
				rating: row.rating,
				placeName: sighting.placeName,
				seenOn: sighting.seenOn,
				price: sighting.price,
				memo: sighting.memo,
				photoUrl: sighting.photoUrl,
				photoUrls: sighting.photoUrls,
				photoIndex: sighting.photoIndex,
			});
		}
	}

	return {
		id: batchRow.batch.id,
		placeName: batchRow.placeName,
		seenOn: batchRow.batch.seenOn,
		photoUrls: batchRow.batch.photoKeys.map(imagePathForKey),
		createdAt: batchRow.batch.createdAt.getTime(),
		createdEntries: entryRows.map((row) => ({
			...toBatchDetailEntry(row),
			sighting: sightingByEntry.get(row.id) ?? null,
		})),
		matchedSightings,
	};
}

/**
 * 一括登録バッチの写真をR2へ保存し、キー配列を確定する(2段階目)。
 *
 * **通常の導線はここを通らない**。一括抽出はジョブ経路(#474)で、写真は解析の投入
 * 時点で既に R2 にあるため、レビュー画面は `adoptImportBatchPhotoKeys` で引き継ぐ。
 * ここが残っているのは、引き継ぐべき写真がジョブ側に無かった回(受け取り済みから
 * 24時間経って `sweepConsumedJobPhotos` が回収した後など)に、手元に `File` が
 * あるぶんを送り直せるようにするフォールバックのため。
 *
 * 受け入れ条件(排他・申告枚数の照合)と銘柄への複製は
 * `assertImportBatchAcceptsPhotos` / `attachImportBatchPhotoKeys` が持つ。
 *
 * R2キーは `wines/{userId}/{batchId}/{photoId}.{ext}`。エントリ写真と同じ
 * `wines/` 接頭辞に載せる理由は db/schema.ts の importBatch の JSDoc を参照
 * (認可・署名URL・退会時削除がこのレイアウトと一対の契約になっている)。
 */
export async function saveImportBatchPhotos(
	userId: string,
	batchId: string,
	photos: Array<{ bytes: ArrayBuffer | Uint8Array; mimeType: string }>,
): Promise<ImportBatchEntry> {
	// 受け入れ可否は**R2へ書く前**に確かめる(後で拒否すると孤児オブジェクトの掃除が要る)。
	// 同じ検証を最後の attach でもう一度通るが、その往復1回より孤児の方が高く付く。
	await assertImportBatchAcceptsPhotos(userId, batchId, photos.length);

	const putKeys: string[] = [];
	try {
		for (const photo of photos) {
			// 保存する Content-Type は申告値ではなく実バイトから確定する(#150)。
			// 新しい入力経路を足すときに必ずこの関門を通す(#174)。
			const bytes =
				photo.bytes instanceof Uint8Array
					? photo.bytes
					: new Uint8Array(photo.bytes);
			const mime = resolveStoredPhotoMime(bytes, photo.mimeType);
			if (!mime) {
				throw new BadRequestError(
					"画像として認識できないか、形式が申告値と一致しないファイルが含まれています",
				);
			}
			const key = buildWinePhotoKey(userId, batchId, crypto.randomUUID(), mime);
			await env.AVATARS.put(key, bytes, {
				httpMetadata: { contentType: mime },
			});
			putKeys.push(key);
		}
	} catch (e) {
		// 巻き戻しの成否に関わらず元例外を投げる(掃除の失敗で真因を隠さない)
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: batchId,
			phase: "import-batch-rollback",
			originalErr: e,
		});
		throw e;
	}

	try {
		return await attachImportBatchPhotoKeys(userId, batchId, putKeys);
	} catch (e) {
		// 事前検証からここまでの間にバッチが消えた/他の経路が写真を載せた回。
		// put 済みのオブジェクトは誰からも参照されないので掃除する。
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: batchId,
			phase: "import-batch-attach-failed",
			originalErr: e,
		});
		throw e;
	}
}

/**
 * バッチが写真を受け入れられるかを確かめる。**キーではなく枚数だけ**を見るので、
 * R2 へ書く前の事前検証としても、キー確定後の関門としても同じ条件で使える。
 *
 * リスト/棚の写真は**バッチに1回だけ置き、銘柄ごとに複製しない**。目撃記録は
 * photoIndex でこの配列を指す。したがって**順番と枚数が登録時の申告
 * (photoCount)と一致していること**が意味の前提になり、ここでずれると
 * 「別の写真で見かけたことになる」ため、枚数が合わなければ拒否する。
 *
 * **枚数の照合は import_batch.photo_count と行う**(#405)。この列を持つ前に
 * 作られたバッチは `null` で、申告枚数を復元する手立てが無いので照合を飛ばす
 * (目撃記録の最大 photoIndex から下限は導けるが、それは申告枚数とは別物で、
 * 「その写真を誰も指していない」だけの正常なバッチを誤って拒否する)。
 * **順番はサーバ側では検証できない**——受け取った配列の順序が撮影順である保証は
 * 呼び出し側にしか無い。枚数の一致は、抜けたファイルによる繰り上がり
 * (= 別の写真を指す)を検出する代理指標として効く。
 *
 * 既に写真が入っているバッチへの追加・差し替えは受け付けない(冪等性のためでは
 * なく、目撃記録の photoIndex が既に確定した配列を指しているため)。
 */
async function assertImportBatchAcceptsPhotos(
	userId: string,
	batchId: string,
	count: number,
): Promise<void> {
	if (count > MAX_PHOTOS_PER_IMPORT_BATCH) {
		throw new BadRequestError(
			`写真は最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚までです`,
		);
	}
	const [existing] = await db
		.select({
			photoKeys: importBatch.photoKeys,
			photoCount: importBatch.photoCount,
		})
		.from(importBatch)
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!existing) throw new NotFoundError("Import batch not found");
	if (existing.photoKeys.length > 0) {
		throw new ConflictError("このバッチの写真は保存済みです");
	}
	if (existing.photoCount != null && count !== existing.photoCount) {
		throw new BadRequestError(
			`写真の枚数が登録時の申告(${existing.photoCount}枚)と一致しません`,
		);
	}
}

/**
 * バッチに写真キーを載せる**唯一の関門**(#617)。実体をアップロードした回
 * (`saveImportBatchPhotos`)も、解析ジョブから引き継いだ回
 * (`adoptImportBatchPhotoKeys`)も、必ずここを通る。
 *
 * **銘柄への複製(#473 の3段目)をここに置くのが肝**。以前は写真のアップロード経路
 * だけが複製を呼んでいて、ジョブから引き継いだ回(手元に `File` が無い回)は
 * 銘柄の `photo_keys` が空のままだった——レビュー画面には写真が出ているのに、
 * 登録した銘柄には1枚も付かない(#617)。**バッチに写真が載る経路を足すときは、
 * この関数を通す**こと(経路ごとに複製を書き足さない)。
 */
async function attachImportBatchPhotoKeys(
	userId: string,
	batchId: string,
	keys: string[],
): Promise<ImportBatchEntry> {
	await assertImportBatchAcceptsPhotos(userId, batchId, keys.length);
	const [row] = await db
		.update(importBatch)
		.set({ photoKeys: keys })
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)))
		.returning();
	if (!row) throw new NotFoundError("Import batch not found");
	// 写真がまだ無い銘柄へ、一括登録の写真を複製する(#473 の3段目)。
	await adoptBatchPhotosForWines(userId, batchId, keys);
	return toImportBatchEntry(row);
}

/**
 * このバッチで作った銘柄のうち**まだ写真を持たないもの**へ、バッチ写真を複製する
 * (#473 の3段目のフォールバック)。
 *
 * 優先順の最後に来る手当てで、前2段はここへ来る前に済んでいる:
 *  1. 手元の写真にその1本だけを写した適切な写真があれば、クライアントがその番号を
 *     目撃記録の `photoIndex` に載せてくる(import-candidates.ts)
 *  2. 無ければ web から取り込む(`adoptWebPhotos`。取り込めた銘柄は photo_keys を持つ)
 *  3. どちらも無い銘柄がここで、目撃記録が指す写真(= リストや棚の全体写真)をそのまま使う
 *
 * 複製するのは**対応写真のすべて**(#574)。そのワインが写っていた写真は目撃記録の
 * `photo_indexes` に残っているので、先頭1枚だけでなく上限
 * (`MAX_PHOTOS_PER_ENTRY`)まで複製する。銘柄1件に保存できるのは6枚までで、
 * 一括登録の上限(10枚)より小さいため、はみ出したぶんは目撃記録の参照だけが残る。
 *
 * **参照ではなく複製にする**。バッチ写真はバッチ取り消し(`undoImportBatch`)で消えるが、
 * 取り消しで消えるのは「そのバッチが作ったもの」だけで、既存エントリに目撃記録を足した
 * ぶんのエントリは残る。キーを共有していると、残ったエントリの写真が消える。
 *
 * **失敗しても写真の保存自体は成功として返す**。ここは付随的な手当てで、例外にすると
 * 「銘柄の写真が用意できなかったせいでバッチ写真の保存が失敗した」ことになる
 * (`adoptImportBatchPhotoKeys` が上限超過を捨てるのと同じ流儀)。
 */
async function adoptBatchPhotosForWines(
	userId: string,
	batchId: string,
	batchPhotoKeys: string[],
): Promise<void> {
	if (batchPhotoKeys.length === 0) return;
	try {
		// このバッチが作った銘柄と、その体験記録が指す写真番号。
		// 既存エントリに体験を足しただけのものは batch_id を持たないので、
		// ここには出てこない(#363 案A)。
		// drank では絞らない。1行化した統合後は「飲んだ」品も drank=1 の行に
		// photoIndex を持つため、絞ると銘柄写真のフォールバックが効かなくなる。
		// 旧2行体制のバッチでは drank=1 の行も混ざるが、そちらは写真番号を
		// 持たないので下の sourceKeys が空になり何も起きない。
		const rows = await db
			.select({
				id: drunkWine.id,
				photoKeys: drunkWine.photoKeys,
				photoIndex: wineEncounter.photoIndex,
				photoIndexes: wineEncounter.photoIndexes,
			})
			.from(drunkWine)
			.innerJoin(
				wineEncounter,
				and(
					eq(wineEncounter.drunkWineId, drunkWine.id),
					eq(wineEncounter.batchId, batchId),
				),
			)
			.where(and(eq(drunkWine.batchId, batchId), eq(drunkWine.userId, userId)));

		const updates: BatchStatement[] = [];
		const putKeys: string[] = [];
		// 同じ写真を指す銘柄が複数あるのが普通(1枚の棚写真に何本も写っている)。
		// R2 からの読み出しは写真ごとに1回にする。
		const sources = new Map<
			string,
			{ bytes: ArrayBuffer; contentType: string } | null
		>();
		const readSource = async (key: string) => {
			const cached = sources.get(key);
			if (cached !== undefined) return cached;
			const object = await env.AVATARS.get(key);
			// contentType は保存時に実バイトから確定した値(resolveStoredPhotoMime)。
			// 許可外なら複製先のキーを作れないので、その写真は諦める。
			const contentType = object?.httpMetadata?.contentType;
			const loaded =
				object && contentType && photoExtForMime(contentType)
					? { bytes: await object.arrayBuffer(), contentType }
					: null;
			sources.set(key, loaded);
			return loaded;
		};

		for (const row of rows) {
			// 既に写真がある = 適切な写真か web 画像で手当て済み(前2段)。触らない。
			if (row.photoKeys.length > 0) continue;
			// 対応写真のすべてを、エントリの上限まで複製する(#574)。範囲外の番号は
			// 指す先が無いので落とす(読み取りの `toEncounterEntry` と同じ扱い)。
			const sourceKeys = encounterPhotoIndexes(row)
				.map((index) => batchPhotoKeys[index])
				.filter((key): key is string => !!key)
				.slice(0, MAX_PHOTOS_PER_ENTRY);
			if (sourceKeys.length === 0) continue;
			const newKeys: string[] = [];
			for (const sourceKey of sourceKeys) {
				const source = await readSource(sourceKey);
				if (!source) continue;
				// **参照ではなく複製**を持たせる(理由はこの関数の JSDoc)。
				const key = buildWinePhotoKey(
					userId,
					row.id,
					crypto.randomUUID(),
					source.contentType,
				);
				await env.AVATARS.put(key, source.bytes, {
					httpMetadata: { contentType: source.contentType },
				});
				putKeys.push(key);
				newKeys.push(key);
			}
			if (newKeys.length === 0) continue;
			updates.push(
				db
					.update(drunkWine)
					// バッチ写真の複製は利用者自身が撮った写真 = bottle。
					// ここに来る行は photo_keys が空なので photo_kinds も空のはずだが、
					// 念のためキー対応ではなく bottle の配列で置く。
					.set({
						photoKeys: newKeys,
						photoKinds: newKeys.map(() => "bottle" as PhotoKind),
					})
					.where(and(eq(drunkWine.id, row.id), eq(drunkWine.userId, userId))),
			);
		}
		if (updates.length === 0) return;
		try {
			await db.batch(updates as [BatchStatement, ...BatchStatement[]]);
		} catch (e) {
			await cleanupPhotoObjects(putKeys, {
				userId,
				entryId: batchId,
				phase: "import-batch-adopt-rollback",
				originalErr: e,
			});
			throw e;
		}
	} catch (err) {
		logWarn("import batch photo adoption failed", { userId, batchId, err });
	}
}
