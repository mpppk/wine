import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { aopReferenceLink } from "#/db/schema";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { withinRateLimit } from "#/lib/rate-limit";
import { fetchPageTitle } from "#/lib/reference-link/fetch-title";
import type {
	CreateReferenceLinkInput,
	UpdateReferenceLinkInput,
} from "#/lib/reference-link/schema";
import { getAop, legacyAopIdsFor, resolveAopId } from "#/lib/wine/service";

// 参考リンク(村・畑・地方・シャトーごと・非公開)のサービス層。全関数が userId で
// スコープし、他ユーザのリンクは読めない/触れない。AOPは静的マスタ参照(FKなし)の
// ため、ここで getAop() 存在検証する。getAop() は退役ID(改名・削除された旧スラッグ)を
// 後継 AOP へ解決するので、旧IDで保存済みのリンクも後継 AOP の画面から扱える(#333)。

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
		throw new BadRequestError(`Unknown AOP: ${aopId}`);
	}
}

// タイトルを確定する。ユーザ入力があればそれを使い、無ければリンク先ページから
// 自動取得する(取得失敗時は null)。
//
// **自動取得は任意URLへのサーバ側 fetch** で、Cloudflare の egress IP とアプリの UA を
// 使った外部への送信リレーになりうる(#397)。書き込み全体のスロットルとは別に、
// ここだけ厳しい上限を掛ける。ユーザがタイトルを手入力した場合はそもそも外部へ出ないので
// 上限も消費しない。
//
// 上限に当たったときは throw せず null(タイトル未確定)に倒す。呼び出し側の本来の意図は
// 「リンクを保存すること」で、表示はURLで代替できる。ここで 429 にすると、自動取得という
// 補助機能のためにリンク保存そのものが失敗する。
async function resolveTitle(
	userId: string,
	url: string,
	title: string | null | undefined,
): Promise<string | null> {
	const trimmed = title?.trim();
	if (trimmed) return trimmed;
	if (!(await withinRateLimit("fetchTitle", userId, { userId }))) return null;
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
				// 改名前のIDで保存されたリンクも同じ AOP のものとして拾う。これが無いと
				// 旧IDのリンクは閲覧も削除もできない到達不能データになる(#333)。
				inArray(aopReferenceLink.aopId, [aopId, ...legacyAopIdsFor(aopId)]),
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
	const title = await resolveTitle(userId, input.url, input.title);
	const id = crypto.randomUUID();
	const [row] = await db
		.insert(aopReferenceLink)
		.values({
			id,
			userId,
			// 退役IDで送られてきた場合は現行IDへ正規化して保存する(#333)
			aopId: resolveAopId(input.aopId) ?? input.aopId,
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
	if (!existing) throw new NotFoundError("Entry not found");

	const nextUrl = input.url ?? existing.url;
	// title 未指定(undefined)は変更しない。title 指定(文字列/null)は解決し直す
	// (null=クリア→ページから再取得)。url だけ変えた場合はタイトルを維持する。
	const nextTitle =
		input.title === undefined
			? existing.title
			: await resolveTitle(userId, nextUrl, input.title);

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
	if (!row) throw new NotFoundError("Entry not found");
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
	if (!row) throw new NotFoundError("Entry not found");
}
