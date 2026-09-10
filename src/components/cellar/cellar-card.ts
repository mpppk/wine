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
export function buildCellarCardLines(entry: DrunkWineEntry): string[] {
	const lines: string[] = [];
	if (entry.lastDrankOn) {
		lines.push(entry.lastDrankOn);
	}
	if (entry.tastingCount > 1) {
		lines.push(`${entry.tastingCount}回飲んだ`);
	}
	const provenance = provenanceNameJa(entry);
	if (provenance) {
		lines.push(provenance);
	}
	if (entry.producer) {
		lines.push(entry.producer);
	}
	return lines;
}
