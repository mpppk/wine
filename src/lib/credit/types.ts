// credit_ledger.type の唯一の情報源(SSOT)。台帳の種別IDと日本語ラベルをここで
// 一元管理する(QUIZ_TYPES と同じ as-const パターン)。schema.ts の type カラムの
// .$type()、書き込み・集計側のリテラル、UIのラベル表はすべてこの union/レコードから
// 導出し、新しい種別の追加漏れをコンパイラが検出できるようにする。
//
//  - grant         : 月次の自動付与
//  - grant_upgrade : 月途中のプレミアムアップグレードによる差分付与
//  - consume       : AI利用による消費(符号は負)
//  - refund        : 失敗時などの返却
//  - admin_grant   : 管理画面からの手動/一括付与(月次付与と区別する)
export const CREDIT_LEDGER_TYPES = [
	{ id: "grant", labelJa: "付与" },
	{ id: "grant_upgrade", labelJa: "アップグレード付与" },
	{ id: "consume", labelJa: "消費" },
	{ id: "refund", labelJa: "返却" },
	{ id: "admin_grant", labelJa: "管理付与" },
] as const;

export type CreditLedgerType = (typeof CREDIT_LEDGER_TYPES)[number]["id"];

/** 台帳種別 → 日本語ラベル。UI表示はこのレコードから引く(全種別の網羅を型が保証する)。 */
export const CREDIT_LEDGER_TYPE_LABELS_JA: Record<CreditLedgerType, string> =
	Object.fromEntries(
		CREDIT_LEDGER_TYPES.map((t) => [t.id, t.labelJa]),
	) as Record<CreditLedgerType, string>;

/**
 * 台帳種別の日本語ラベルを引く。server fn 境界で型が string に広がった値も受けられるよう
 * string を受け、未知の種別(将来値・データ不整合)はIDをそのまま返す。
 */
export function creditLedgerTypeLabel(type: string): string {
	return CREDIT_LEDGER_TYPE_LABELS_JA[type as CreditLedgerType] ?? type;
}
