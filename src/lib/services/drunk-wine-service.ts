import { env } from "cloudflare:workers";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine } from "#/db/schema";
import {
	buildWinePhotoKey,
	MAX_PHOTOS_PER_ENTRY,
} from "#/lib/drunk-wine/photo";
import type {
	CreateDrunkWineInput,
	UpdateDrunkWineInput,
} from "#/lib/drunk-wine/schema";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { getAop, getVariety } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// 飲んだワイン(マイセラー)のサービス層。Webのserver fnとMCPツールの
// 共通入口で、D1(drunk_wine)とR2(写真)への薄い橋渡しに徹する。
// AOP・品種は静的マスタ参照(FKなし)のため、ここで存在検証する。

export interface DrunkWineEntry {
	id: string;
	name: string;
	drankOn: string | null;
	aopId: string | null;
	/** AOP紐付け時のみ。静的マスタから導出 */
	aopNameJa: string | null;
	regionId: RegionId | null;
	rating: number | null;
	memo: string | null;
	vintage: number | null;
	grapeVarietyIds: string[];
	producer: string | null;
	price: number | null;
	/** 写真の相対URL(/api/images/...)の配列。表示順で先頭=代表。呼び出し側で必要なら絶対化する */
	photoUrls: string[];
	createdAt: number;
	updatedAt: number;
}

type DrunkWineRow = typeof drunkWine.$inferSelect;

function toEntry(row: DrunkWineRow): DrunkWineEntry {
	const aop = row.aopId ? getAop(row.aopId) : undefined;
	return {
		id: row.id,
		name: row.name,
		drankOn: row.drankOn,
		aopId: row.aopId,
		aopNameJa: aop?.nameJa ?? null,
		regionId: aop?.region ?? null,
		rating: row.rating,
		memo: row.memo,
		vintage: row.vintage,
		grapeVarietyIds: row.grapeVarietyIds,
		producer: row.producer,
		price: row.price,
		photoUrls: row.photoKeys.map((key) => `/api/images/${key}`),
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

function assertValidRefs(input: {
	aopId?: string | null;
	grapeVarietyIds?: string[];
}) {
	if (input.aopId && !getAop(input.aopId)) {
		throw new BadRequestError(`Unknown AOP: ${input.aopId}`);
	}
	for (const id of input.grapeVarietyIds ?? []) {
		if (!getVariety(id)) {
			throw new BadRequestError(`Unknown grape variety: ${id}`);
		}
	}
}

// 作成入力。Web(zodのCreateDrunkWineInput)に加え、MCPツールが共通の
// snake→camelマッピング(toWinePatch)をそのまま渡せるよう null も受け付ける
// (下で ?? null に正規化されるため null と undefined は等価)。
type CreateDrunkWineData = Omit<UpdateDrunkWineInput, "id"> & { name: string };

export async function createDrunkWine(
	userId: string,
	input: CreateDrunkWineInput | CreateDrunkWineData,
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const id = crypto.randomUUID();
	const [row] = await db
		.insert(drunkWine)
		.values({
			id,
			userId,
			name: input.name,
			drankOn: input.drankOn ?? null,
			aopId: input.aopId ?? null,
			rating: input.rating ?? null,
			memo: input.memo ?? null,
			vintage: input.vintage ?? null,
			grapeVarietyIds: input.grapeVarietyIds ?? [],
			producer: input.producer ?? null,
			price: input.price ?? null,
		})
		.returning();
	if (!row) throw new Error("Failed to insert drunk wine");
	return toEntry(row);
}

export async function updateDrunkWine(
	userId: string,
	input: UpdateDrunkWineInput,
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const { id, ...patch } = input;
	// undefined = 変更しない / null = クリア。undefinedキーはdrizzleが無視する
	const [row] = await db
		.update(drunkWine)
		.set({
			name: patch.name,
			drankOn: patch.drankOn,
			aopId: patch.aopId,
			rating: patch.rating,
			memo: patch.memo,
			vintage: patch.vintage,
			grapeVarietyIds: patch.grapeVarietyIds,
			producer: patch.producer,
			price: patch.price,
		})
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	// 存在しない/他ユーザ所有を区別せず同じエラーにする(存在の探索を防ぐ)
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

export async function deleteDrunkWine(
	userId: string,
	id: string,
): Promise<void> {
	const [row] = await db
		.delete(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning({ photoKeys: drunkWine.photoKeys });
	if (!row) throw new NotFoundError("Entry not found");
	// R2は複数キー一括削除に対応(存在しないキーは無視される)
	if (row.photoKeys.length > 0) await env.AVATARS.delete(row.photoKeys);
}

export async function listDrunkWines(
	userId: string,
): Promise<DrunkWineEntry[]> {
	const rows = await db
		.select()
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId))
		.orderBy(desc(drunkWine.createdAt));
	return rows.map(toEntry);
}

/**
 * マイセラーの登録本数と直近1件を返す。ダッシュボードのサマリー表示用。
 * 直近1件は createdAt 降順の先頭(既存 index drunk_wine_user_created_idx が効く)。
 */
export async function countAndLatestDrunkWine(
	userId: string,
): Promise<{ count: number; latest: DrunkWineEntry | null }> {
	const [countRow] = await db
		.select({ count: sql<number>`count(*)` })
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId));
	const [latestRow] = await db
		.select()
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId))
		.orderBy(desc(drunkWine.createdAt))
		.limit(1);
	return {
		count: countRow?.count ?? 0,
		latest: latestRow ? toEntry(latestRow) : null,
	};
}

export async function getDrunkWine(
	userId: string,
	id: string,
): Promise<DrunkWineEntry> {
	const [row] = await db
		.select()
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

/** syncDrunkWinePhotos に渡す最終並び順の1要素。既存キーの保持か、新規バイト列の追加。 */
export type PhotoLayoutItem =
	| { kind: "existing"; key: string }
	| { kind: "new"; bytes: Uint8Array | ArrayBuffer; mimeType: string };

/**
 * エントリの写真集合を layout(最終並び順)へ全置換で同期する。追加・削除・並べ替え・
 * 差し替えを1回で反映する。新規はR2へ保存し、旧配列にあって残らないキーは削除して
 * 残骸を残さない。layout の existing キーは対象エントリの現在の集合に属するもののみ
 * 許可する(他エントリ/任意キーの注入を防ぐ)。Webルート・MCPツール共用。
 */
export async function syncDrunkWinePhotos(
	userId: string,
	id: string,
	layout: PhotoLayoutItem[],
): Promise<DrunkWineEntry> {
	if (layout.length > MAX_PHOTOS_PER_ENTRY) {
		throw new BadRequestError(`写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです`);
	}
	const [existing] = await db
		.select({ photoKeys: drunkWine.photoKeys })
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!existing) throw new NotFoundError("Entry not found");

	const currentKeys = existing.photoKeys;
	const currentSet = new Set(currentKeys);
	for (const item of layout) {
		if (item.kind === "existing" && !currentSet.has(item.key)) {
			throw new BadRequestError("Unknown photo");
		}
	}

	// 新規をR2へ保存しつつ最終キー配列を組み立てる。put途中で失敗したら今回put分を巻き戻す
	const putKeys: string[] = [];
	const nextKeys: string[] = [];
	try {
		for (const item of layout) {
			if (item.kind === "existing") {
				nextKeys.push(item.key);
				continue;
			}
			const key = buildWinePhotoKey(
				userId,
				id,
				crypto.randomUUID(),
				item.mimeType,
			);
			await env.AVATARS.put(key, item.bytes, {
				httpMetadata: { contentType: item.mimeType },
			});
			putKeys.push(key);
			nextKeys.push(key);
		}
	} catch (e) {
		if (putKeys.length > 0) await env.AVATARS.delete(putKeys);
		throw e;
	}

	const [row] = await db
		.update(drunkWine)
		.set({ photoKeys: nextKeys })
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	// 存在確認とここまでの間にエントリが削除された場合、put分を掃除する
	if (!row) {
		if (putKeys.length > 0) await env.AVATARS.delete(putKeys);
		throw new NotFoundError("Entry not found");
	}

	// 旧配列にあって新配列に残らないキーを削除(削除・差し替え・並べ替えを一括反映)
	const nextSet = new Set(nextKeys);
	const removed = currentKeys.filter((key) => !nextSet.has(key));
	if (removed.length > 0) await env.AVATARS.delete(removed);

	return toEntry(row);
}
