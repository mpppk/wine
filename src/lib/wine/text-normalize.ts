/**
 * マスタ照合・検索用のテキスト正規化。アクセント記号を落とし(é→e)、小文字化し、
 * 記号・中点等をスペースに畳む。日本語(かな・カナ・漢字)はそのまま残すので
 * nameJa とも比較できる。
 *
 * AIエチケット解析のマスタ照合(lib/ai/label-extraction)と産地ピッカーの検索
 * (lib/wine/provenance)が同じ正規化を共有する(表記揺れの吸収規則がドリフト
 * しないよう、実装はここに1つだけ置く)。
 */
export function normalizeLabelText(text: string): string {
	return (
		text
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			// 中点(U+30FB)はカタカナブロック内にあり下の許可クラスに残るため、先に区切り化する
			.replace(/・/g, " ")
			.replace(/[^a-z0-9぀-ヿ一-鿿]+/gu, " ")
			.trim()
			.replace(/\s+/g, " ")
			// NFKDで分解されたままの濁点・半濁点(U+3099/309A)を合成形に戻す
			.normalize("NFC")
	);
}
