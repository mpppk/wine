// 管理画面のユーザ検索・ページネーションの純粋ロジック。DBアクセスを持たない
// 関数として切り出し、サービス層(admin-service)とテストで共有する。

/** ユーザ一覧の1ページあたりの件数。 */
export const ADMIN_USERS_PAGE_SIZE = 20;

/**
 * 検索語を SQLite の LIKE 部分一致パターンに変換する。
 * ユーザ入力の % _ \ をエスケープするため、クエリ側で ESCAPE '\' を併用すること。
 */
export function likeContains(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 総件数からページ数を求める。0件でも1ページ(空ページ)として扱う。 */
export function totalPages(total: number, pageSize: number): number {
	return Math.max(1, Math.ceil(total / pageSize));
}

/** 要求ページを [1, totalPages] に丸める。 */
export function clampPage(
	page: number,
	total: number,
	pageSize: number,
): number {
	return Math.min(Math.max(1, page), totalPages(total, pageSize));
}
