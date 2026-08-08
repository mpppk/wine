import { NOTE_MAX } from "./schema";

// 銘柄のコメント(`drunk_wine.note`)の組み立て(Issue #471 / #473)。
//
// 書き手が複数いるフィールドなので、**見出しと上限の扱いをここ1箇所に置く**:
//  - エチケット解析(高精度経路)の香り・味わい / 生産者のコメント(#471)
//  - アプリが持っている生産者の解説の流用(#471)
//  - 一括登録で web から取り込んだ写真と実物のズレの注記(#473)
//
// 経路ごとに文字列を組むと、見出しの表記が割れて画面上の見え方がバラつき、
// 上限(NOTE_MAX)の切り詰めも片方だけ抜ける。ランタイム非依存に保つ
// (drunk-wine/schema.ts と同じ方針)。

/** コメントの見出し。保存されるのは素のテキストなので、Markdown ではなく素の見出しにする。 */
export const NOTE_SECTION_LABELS = {
	tasting: "【香り・味わい】",
	producer: "【生産者】",
	/** web から取り込んだ写真についての注記(#473)。 */
	photo: "【写真について】",
} as const;

/** 上限に収める。超えたぶんは切り詰める(理由は buildWineNote の JSDoc)。 */
function clamp(note: string): string {
	return note.length <= NOTE_MAX ? note : note.slice(0, NOTE_MAX).trimEnd();
}

/**
 * 銘柄のコメントを組み立てる(#471)。
 *
 * 上限を超えたぶんは切り詰める。zod(NOTE_MAX)で弾くと「解析はできたのに保存できない」
 * 袋小路になるため、ここで収める。
 */
export function buildWineNote(input: {
	tasting?: string;
	producer?: string;
	/** 追記する注記(見出し込み)。末尾に段落として足す。 */
	extra?: string;
}): string | undefined {
	const sections: string[] = [];
	if (input.tasting) {
		sections.push(`${NOTE_SECTION_LABELS.tasting}\n${input.tasting}`);
	}
	if (input.producer) {
		sections.push(`${NOTE_SECTION_LABELS.producer}\n${input.producer}`);
	}
	if (input.extra) sections.push(input.extra);
	if (sections.length === 0) return undefined;
	return clamp(sections.join("\n\n"));
}

/**
 * 既存のコメントへ段落を1つ足す(#473)。どちらも無ければ `null` を返す
 * (DBの列がそのまま NULL になる形)。
 *
 * 追記側だけがあるケース(解析がコメントを書かなかった銘柄に写真の注記だけ付く)も
 * ありうるので、既存コメントの有無で分岐させない。
 */
export function appendWineNote(
	note: string | null | undefined,
	extra: string | null | undefined,
): string | null {
	const base = note?.trim();
	const suffix = extra?.trim();
	if (!base) return suffix ? clamp(suffix) : null;
	if (!suffix) return clamp(base);
	return clamp(`${base}\n\n${suffix}`);
}
