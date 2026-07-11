// 既存プレミアム会員が「期間延長」を受けるためのキャンペーンコードを扱う純ロジック。
// DBアクセスを持たず、環境変数 CAMPAIGN_EXTENSION_CODES のパースとコード検証だけを行う。
// サービス層(billing-service)はここで解決した延長日数を使って Stripe を操作する。
//
// Stripe のプロモコードは Checkout(新規入会)専用で既存サブスクには適用できないため、
// 延長コードは Stripe ではなくアプリ側で定義・検証する。

/**
 * 環境変数の書式: "CODE=days" をカンマ区切りで並べる。
 * 例: "WINE7=7,SUMMER=14"
 * - コードは大文字小文字を区別しない(内部では大文字に正規化して保持)。
 * - days は正の整数のみ有効。0以下・非数値・書式不正のエントリは無視する。
 */
export function parseCampaignCodes(
	raw: string | undefined | null,
): Map<string, number> {
	const map = new Map<string, number>();
	if (!raw) return map;
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const code = normalizeCode(trimmed.slice(0, eq));
		const days = Number(trimmed.slice(eq + 1).trim());
		if (!code) continue;
		if (!Number.isInteger(days) || days <= 0) continue;
		map.set(code, days);
	}
	return map;
}

/** コードの正規化(前後空白除去・大文字化)。空文字は無効コード扱い。 */
export function normalizeCode(code: string): string {
	return code.trim().toUpperCase();
}

/**
 * 入力コードに対応する延長日数を返す。未定義・無効なら null。
 * 入力は大文字小文字・前後空白を無視して照合する。
 */
export function resolveExtensionDays(
	code: string,
	config: Map<string, number>,
): number | null {
	const normalized = normalizeCode(code);
	if (!normalized) return null;
	return config.get(normalized) ?? null;
}
