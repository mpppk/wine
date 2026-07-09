import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine } from "#/db/schema";
import { buildWinePhotoKey } from "#/lib/drunk-wine/photo";
import type {
	CreateDrunkWineInput,
	UpdateDrunkWineInput,
} from "#/lib/drunk-wine/schema";
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
	/** 相対URL(/api/images/...)。呼び出し側で必要なら絶対化する */
	photoUrl: string | null;
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
		photoUrl: row.photoKey ? `/api/images/${row.photoKey}` : null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

function assertValidRefs(input: {
	aopId?: string | null;
	grapeVarietyIds?: string[];
}) {
	if (input.aopId && !getAop(input.aopId)) {
		throw new Error(`Unknown AOP: ${input.aopId}`);
	}
	for (const id of input.grapeVarietyIds ?? []) {
		if (!getVariety(id)) {
			throw new Error(`Unknown grape variety: ${id}`);
		}
	}
}

export async function createDrunkWine(
	userId: string,
	input: CreateDrunkWineInput,
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
	if (!row) throw new Error("Entry not found");
	return toEntry(row);
}

export async function deleteDrunkWine(
	userId: string,
	id: string,
): Promise<void> {
	const [row] = await db
		.delete(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning({ photoKey: drunkWine.photoKey });
	if (!row) throw new Error("Entry not found");
	if (row.photoKey) await env.AVATARS.delete(row.photoKey);
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

export async function getDrunkWine(
	userId: string,
	id: string,
): Promise<DrunkWineEntry> {
	const [row] = await db
		.select()
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!row) throw new Error("Entry not found");
	return toEntry(row);
}

/**
 * 写真をR2に保存してエントリに紐付ける。拡張子(MIME)が変わった場合は
 * 旧オブジェクトを消してキーの残骸を残さない。Webルート・MCPツール共用。
 */
export async function setDrunkWinePhoto(
	userId: string,
	id: string,
	bytes: Uint8Array | ArrayBuffer,
	mimeType: string,
): Promise<DrunkWineEntry> {
	const [existing] = await db
		.select({ photoKey: drunkWine.photoKey })
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!existing) throw new Error("Entry not found");

	const key = buildWinePhotoKey(userId, id, mimeType);
	await env.AVATARS.put(key, bytes, {
		httpMetadata: { contentType: mimeType },
	});
	if (existing.photoKey && existing.photoKey !== key) {
		await env.AVATARS.delete(existing.photoKey);
	}
	const [row] = await db
		.update(drunkWine)
		.set({ photoKey: key })
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	return toEntry(row);
}
