import { eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine, importBatch, quizQuestionStat } from "#/db/schema";
import { MAX_PHOTO_BYTES } from "#/lib/drunk-wine/photo";
import { ConflictError } from "#/lib/errors";
import { logWarn } from "#/lib/logger";

// ユーザあたり容量クォータの単一情報源(#397)。
//
// スロットル(`#/lib/rate-limit` の短時間の回数制限)とは別物で、こちらは**累積の上限**。
// Rate Limiting バインディングは「正確な会計ではない」設計(colo ごとのカウンタ)のため、
// 「1ユーザあたりのエントリ数・写真総バイト数」のような累積の上限は D1 で数えて判定する。
//
// 経路(Web の server function / API ルート / MCP ツール)ごとに上限を書き散らさない。
// 全経路がサービス層(`createDrunkWine` / `bulkRegisterFromScan` /
// `syncDrunkWinePhotos` / `saveImportBatchPhotos` / `recordAnswer`)を通るため、
// 判定はこの1ファイルに閉じ、サービス層が呼ぶ。後から経路を足しても自動的に通る
// (#546 の MCP 追加も同じ構造で足せる)。
//
// 超過は 409(ConflictError)。429 はスロットル用に取っておき、種別を混ぜない
// (クライアントが文言・ステータスで種別を判定できるようにする)。
// 同時実行の競合で上限をわずかに超えることはある(チェックと書き込みの間に隙がある)。
// 金銭のような厳密な会計ではなく濫用の上限なので、バースト自体はスロットル側が抑える
// という分担にする。

/** 1ユーザが持てる銘柄エントリの上限。無制限のままだと R2/D1 を無限に積める。 */
export const MAX_ENTRIES_PER_USER = 5000;

/**
 * 1ユーザが R2 に置ける写真の総バイト上限(2GiB)。
 *
 * D1 は写真1枚の実バイト数を持たないため、既存ぶんは「枚数 × 1枚の上限」で
 * **保守的に見積もる**(実サイズより大きく見積もる側に倒す)。新規ぶんは実バイトで数える。
 * 見積もりが実態より大きいぶん、通常利用(数百枚)では当たらない余裕を見てある。
 */
export const MAX_PHOTO_BYTES_PER_USER = 2 * 1024 * 1024 * 1024;

/**
 * 1ユーザが持てるクイズ実績(`quiz_question_stat`)の行数上限。
 *
 * `recordAnswer` は実在する問題キーしか受け付けない(`getQuestionKeyInfo` が列挙集合と
 * 突合)ため、行数は原理的に全地域の候補総数(~9700件・2026-09時点)で頭打ちになる。
 * この上限は地域追加ぶんの余裕を見た defence-in-depth で、通常利用では当たらない。
 */
export const MAX_QUIZ_STATS_PER_USER = 15000;

async function countEntries(userId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId));
	return row?.count ?? 0;
}

/**
 * 新規エントリを作る前に呼ぶ。`createdCount` 件作っても上限を超えないことを保証する。
 * `createDrunkWine`(1件)と `bulkRegisterFromScan`(複数件)の両方が呼ぶ。
 */
export async function assertEntryQuota(
	userId: string,
	newCount: number,
): Promise<void> {
	if (newCount <= 0) return;
	const current = await countEntries(userId);
	if (current + newCount > MAX_ENTRIES_PER_USER) {
		logWarn("entry quota exceeded", { userId, current, newCount });
		throw new ConflictError(
			`ワインの登録数が上限(${MAX_ENTRIES_PER_USER}件)に達しています。不要なエントリを削除してお試しください。`,
		);
	}
}

/**
 * 写真を R2 へ書く前に呼ぶ。`newBytes` は今回書き込む実バイト数の合計。
 * 既存ぶんはエントリ写真(`drunk_wine.photo_keys`)とバッチ写真
 * (`import_batch.photo_keys`)の枚数 × 1枚上限で見積もる。
 * `syncDrunkWinePhotos` と `saveImportBatchPhotos` の両方が呼ぶ。
 */
export async function assertPhotoQuota(
	userId: string,
	newBytes: number,
): Promise<void> {
	const [entryRows, batchRows] = await Promise.all([
		db
			.select({ photoKeys: drunkWine.photoKeys })
			.from(drunkWine)
			.where(eq(drunkWine.userId, userId)),
		db
			.select({ photoKeys: importBatch.photoKeys })
			.from(importBatch)
			.where(eq(importBatch.userId, userId)),
	]);
	let photoCount = 0;
	for (const row of entryRows) photoCount += row.photoKeys.length;
	for (const row of batchRows) photoCount += row.photoKeys.length;
	const estimatedTotal = photoCount * MAX_PHOTO_BYTES + newBytes;
	if (estimatedTotal > MAX_PHOTO_BYTES_PER_USER) {
		logWarn("photo quota exceeded", { userId, photoCount, newBytes });
		throw new ConflictError(
			"写真の保存容量が上限(2GB)に達しています。不要な写真を削除してお試しください。",
		);
	}
}

/**
 * `recordAnswer` が新規行を作る前に呼ぶ。既存キーへの回答(行の更新)は数えない——
 * 抑えるのは行数の増加だけで、学習の継続を妨げない。
 */
export async function assertQuizQuotaForNewKey(userId: string): Promise<void> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(quizQuestionStat)
		.where(eq(quizQuestionStat.userId, userId));
	const current = row?.count ?? 0;
	if (current >= MAX_QUIZ_STATS_PER_USER) {
		logWarn("quiz quota exceeded", { userId, current });
		throw new ConflictError(
			`クイズの記録数が上限(${MAX_QUIZ_STATS_PER_USER}件)に達しています。`,
		);
	}
}
