// 管理画面の各カードで共有する日時整形ヘルパ。表示は日本語ロケール固定。

export function formatDateTime(d: Date): string {
	return d.toLocaleString("ja-JP");
}

export function formatDate(d: Date | null): string {
	return d ? d.toLocaleDateString("ja-JP") : "-";
}
