import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { provenanceNameJa } from "#/lib/wine/provenance";

// マイセラー一覧(/cellar)のカードに並ぶ補助行を作る純ロジック。表示コンポーネント
// から切り出してあるのは、「何を出す・何を出さないか」だけを単体テストで固定する
// ため(wine-detail.ts と同じ流儀)。
//
// 規約(Issue #597):
//  - 生産者は重要な情報なので出す
//  - 代わりにヴィンテージは出さない
//  - 値が無い項目は行ごと落とす(空の span が並ぶのを避ける)
// カード補助行の1行。`key` は行の出どころ(日付・回数・産地・生産者)で、
// React のリストキーにそのまま使えるよう本文と分けて返す(同文の行が
// 並んでもキーが衝突しない)。
export type CellarCardLine = {
	key: "lastDrankOn" | "tastingCount" | "provenance" | "producer";
	text: string;
};
export function buildCellarCardLines(entry: DrunkWineEntry): CellarCardLine[] {
	const lines: CellarCardLine[] = [];
	if (entry.lastDrankOn) {
		lines.push({ key: "lastDrankOn", text: entry.lastDrankOn });
	}
	if (entry.tastingCount > 1) {
		lines.push({
			key: "tastingCount",
			text: `${entry.tastingCount}回飲んだ`,
		});
	}
	const provenance = provenanceNameJa(entry);
	if (provenance) {
		lines.push({ key: "provenance", text: provenance });
	}
	if (entry.producer) {
		lines.push({ key: "producer", text: entry.producer });
	}
	return lines;
}
