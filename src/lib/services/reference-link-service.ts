import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { aopReferenceLink } from "#/db/schema";
import { fetchPageTitle } from "#/lib/reference-link/fetch-title";
import type {
	CreateReferenceLinkInput,
	UpdateReferenceLinkInput,
} from "#/lib/reference-link/schema";
import { getAop } from "#/lib/wine/service";

// 参考リンク(村・畑・地方・シャトーごと・非公開)のサービス層。全関数が userId で
// スコープし、他ユーザのリンクは読めない/触れない。AOPは静的マスタ参照(FKなし)の
// ため、ここで getAop() 存在検証する。

export interface ReferenceLinkEntry {
	id: string;
	aopId: string;
	url: string;
	/** null なら表示側が URL/ホスト名で代替する */
	title: string | null;
	createdAt: number;
	updatedAt: number;
}

type ReferenceLinkRow = typeof aopReferenceLink.$inferSelect;

function toEntry(row: ReferenceLinkRow): ReferenceLinkEntry {
	return {
		id: row.id,
		aopId: row.aopId,
		url: row.url,
		title: row.title,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

function assertKnownAop(aopId: string) {
	if (!getAop(aopId)) {
		throw new Error(`Unknown AOP: ${aopId}`);
	}
}

// タイトルを確定する。ユーザ入力があればそれを使い、無ければリンク先ページから
// 自動取得する(取得失敗時は null)。
async function resolveTitle(
	url: string,
	title: string | null | undefined,
): Promise<string | null> {
	const trimmed = title?.trim();
	if (trimmed) return trimmed;
	return fetchPageTitle(url);
}

export async function listReferenceLinks(
	userId: string,
	aopId: string,
): Promise<ReferenceLinkEntry[]> {
	assertKnownAop(aopId);
	const rows = await db
		.select()
		.from(aopReferenceLink)
		.where(
			and(
				eq(aopReferenceLink.userId, userId),
				eq(aopReferenceLink.aopId, aopId),
			),
		)
		.orderBy(asc(aopReferenceLink.createdAt));
	return rows.map(toEntry);
}

export async function createReferenceLink(
	userId: string,
	input: CreateReferenceLinkInput,
): Promise<ReferenceLinkEntry> {
	assertKnownAop(input.aopId);
	const title = await resolveTitle(input.url, input.title);
	const id = crypto.randomUUID();
	const [row] = await db
		.insert(aopReferenceLink)
		.values({
			id,
			userId,
			aopId: input.aopId,
			url: input.url,
			title,
		})
		.returning();
	if (!row) throw new Error("Failed to insert reference link");
	return toEntry(row);
}

export async function updateReferenceLink(
	userId: string,
	input: UpdateReferenceLinkInput,
): Promise<ReferenceLinkEntry> {
	// 対象の存在・所有を確認しつつ、タイトル解決に必要な現在のURLを取得する
	const [existing] = await db
		.select()
		.from(aopReferenceLink)
		.where(
			and(
				eq(aopReferenceLink.id, input.id),
				eq(aopReferenceLink.userId, userId),
			),
		);
	// 存在しない/他ユーザ所有を区別せず同じエラーにする(存在の探索を防ぐ)
	if (!existing) throw new Error("Entry not found");

	const nextUrl = input.url ?? existing.url;
	// title 未指定(undefined)は変更しない。title 指定(文字列/null)は解決し直す
	// (null=クリア→ページから再取得)。url だけ変えた場合はタイトルを維持する。
	const nextTitle =
		input.title === undefined
			? existing.title
			: await resolveTitle(nextUrl, input.title);

	const [row] = await db
		.update(aopReferenceLink)
		.set({ url: nextUrl, title: nextTitle })
		.where(
			and(
				eq(aopReferenceLink.id, input.id),
				eq(aopReferenceLink.userId, userId),
			),
		)
		.returning();
	if (!row) throw new Error("Entry not found");
	return toEntry(row);
}

export async function deleteReferenceLink(
	userId: string,
	id: string,
): Promise<void> {
	const [row] = await db
		.delete(aopReferenceLink)
		.where(
			and(eq(aopReferenceLink.id, id), eq(aopReferenceLink.userId, userId)),
		)
		.returning({ id: aopReferenceLink.id });
	if (!row) throw new Error("Entry not found");
}
