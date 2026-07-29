import { formatDateJst, formatDateTimeJst } from "#/lib/date/display";

// 管理画面の各カードで共有する日時整形ヘルパ。表示は日本語ロケール・JST固定
// (タイムゾーンを指定しないと SSR(workerd=UTC)とクライアントで文字列が食い違う。#244)。

export function formatDateTime(d: Date): string {
	return formatDateTimeJst(d);
}

export function formatDate(d: Date | null): string {
	return d ? formatDateJst(d) : "-";
}
