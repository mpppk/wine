import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { place } from "#/db/schema";
import { ConflictError, NotFoundError } from "#/lib/errors";
import {
	DEFAULT_PLACE_KIND,
	duplicatePlaceNameMessage,
	type PlaceKind,
} from "#/lib/place/place";
import type { CreatePlaceInput, UpdatePlaceInput } from "#/lib/place/schema";

// 場所(place)のサービス層。「どの店でワインを見かけたか」のユーザ単位マスタで、
// 目撃記録(wine_sighting)と一括登録(import_batch)から参照される(Issue #358)。
//
// 目撃記録そのものは drunk-wine-service.ts が持つ。あちらは集計キャッシュの再計算
// (recomputeDrunkWineAggregates)と同じ db.batch に積む必要があってモジュール私有の
// ヘルパに依存するが、place は drunk_wine と結合しない独立したマスタなので分ける。
//
// 所有権チェックは常に `WHERE id AND userId` の複合条件で行い、「存在しない」と
// 「他ユーザ所有」を同一エラーにして存在探索を防ぐ(docs/architecture.md)。

export interface PlaceEntry {
	id: string;
	name: string;
	kind: PlaceKind;
	memo: string | null;
	createdAt: number;
	updatedAt: number;
}

type PlaceRow = typeof place.$inferSelect;

function toPlaceEntry(row: PlaceRow): PlaceEntry {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		memo: row.memo,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * 自分の場所を名前順で全件返す。一括登録の入力(既存の場所をサジェストする
 * コンボボックス)が主な用途で、ユーザが持つ件数はたかが知れているため
 * ページネーションは持たない(マイセラー本体と違い単調増加しない)。
 * 並び順は place_user_name_idx(user_id, name)がそのまま効く。
 */
export async function listPlaces(userId: string): Promise<PlaceEntry[]> {
	const rows = await db
		.select()
		.from(place)
		.where(eq(place.userId, userId))
		.orderBy(asc(place.name));
	return rows.map(toPlaceEntry);
}

/** 新しく作る place 行の値。呼び出し側が自分の db.batch に積む。 */
export interface NewPlaceValues {
	id: string;
	userId: string;
	name: string;
	kind: PlaceKind;
	memo: string | null;
}

/**
 * 「その場で新しい場所を作る」の**共通チョークポイント**。同名の重複を弾いたうえで、
 * insert する値(採番済みのid付き)を返す。
 *
 * 値だけを返して文を組み立てないのは、場所の作成が単独で完結しないため。呼び出し側は
 * 銘柄・目撃記録・一括登録バッチと**同じ db.batch** に積んで原子的に作る必要がある。
 *
 * 重複の判定は名前の完全一致(zod が trim 済み)。SQLite の `=` は大文字小文字を区別
 * するので、表記が1文字でも違えば別の場所として作れる——支店や曖昧な店名を許す
 * 従来の方針(db/schema.ts)の名残で、ここで弾くのは「まったく同じ名前」だけ。
 *
 * 判定は SELECT → INSERT の2段階で、DB の unique 制約ではない(同名の既存データが
 * ある利用者を登録不能にしないため)。同一ユーザが同時に同じ名前を投げた稀なケースでは
 * すり抜けるが、その結果は従来どおりの同名2件であって壊れた状態ではない。
 */
export async function prepareNewPlace(
	userId: string,
	input: CreatePlaceInput,
): Promise<NewPlaceValues> {
	const [duplicate] = await db
		.select({ id: place.id })
		.from(place)
		.where(and(eq(place.userId, userId), eq(place.name, input.name)))
		.limit(1);
	if (duplicate) throw new ConflictError(duplicatePlaceNameMessage(input.name));
	return {
		id: crypto.randomUUID(),
		userId,
		name: input.name,
		kind: input.kind ?? DEFAULT_PLACE_KIND,
		memo: input.memo ?? null,
	};
}

export async function createPlace(
	userId: string,
	input: CreatePlaceInput,
): Promise<PlaceEntry> {
	const [row] = await db
		.insert(place)
		.values(await prepareNewPlace(userId, input))
		.returning();
	if (!row) throw new Error("Failed to insert place");
	return toPlaceEntry(row);
}

export async function updatePlace(
	userId: string,
	input: UpdatePlaceInput,
): Promise<PlaceEntry> {
	const { id, ...patch } = input;
	// undefined = 変更しない / null = クリア。undefinedキーはdrizzleが無視する。
	// 全キーが未指定だと drizzle が空の SET を拒否するので、その場合は読むだけ。
	if (Object.values(patch).every((v) => v === undefined)) {
		return getPlace(userId, id);
	}
	const [row] = await db
		.update(place)
		.set({ name: patch.name, kind: patch.kind, memo: patch.memo })
		.where(and(eq(place.id, id), eq(place.userId, userId)))
		.returning();
	if (!row) throw new NotFoundError("Place not found");
	return toPlaceEntry(row);
}

export async function getPlace(
	userId: string,
	id: string,
): Promise<PlaceEntry> {
	const [row] = await db
		.select()
		.from(place)
		.where(and(eq(place.id, id), eq(place.userId, userId)));
	if (!row) throw new NotFoundError("Place not found");
	return toPlaceEntry(row);
}

/**
 * 場所を削除する。参照している目撃記録・一括登録バッチは
 * `ON DELETE set null` で残る — 店の登録を消しても「見かけた」という事実自体は
 * 失われないほうが正しい(cascade にすると目撃記録が道連れで消える)。
 */
export async function deletePlace(userId: string, id: string): Promise<void> {
	const [row] = await db
		.delete(place)
		.where(and(eq(place.id, id), eq(place.userId, userId)))
		.returning({ id: place.id });
	if (!row) throw new NotFoundError("Place not found");
}
