import { describe, expect, it } from "vitest";
import { AOPS } from "./aops-data";
import {
	getProducerAwardHighlight,
	sortProducersByAward,
} from "./producer-info";

// 生産者リストの「受賞者を上位に・受賞歴をタップ前に見せる」表示ロジック。
// 辞書(PRODUCER_INFO)の実データを使う。実在の生産者名を参照するため、辞書から
// エントリが消えるとテストが落ちる(意図した削除ならテスト側も直す)。

describe("getProducerAwardHighlight", () => {
	it("階級を持つ賞はバッジに階級、ラベルに制度名+階級を出す", () => {
		expect(getProducerAwardHighlight("Domaine de la Romanée-Conti")).toEqual({
			badgeJa: "3グレープ",
			labelJa: "MICHELIN Grapes 3グレープ",
			rank: 0,
		});
		expect(getProducerAwardHighlight("Château Palmer")).toEqual({
			badgeJa: "第3級",
			labelJa: "メドック格付け 第3級",
			rank: 2,
		});
	});

	it("階級を持たない賞は制度の短縮名をバッジに出す", () => {
		const highlight = getProducerAwardHighlight("Accornero");
		expect(highlight?.badgeJa).toBe("トレ・ビッキエーリ");
		expect(highlight?.labelJa).toBe("Gambero Rosso トレ・ビッキエーリ");
		// 階級を持たない賞は受賞ありの中で最後(受賞なしよりは前)に並ぶ
		expect(highlight?.rank).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("受賞を持たない生産者・辞書に無い生産者は undefined", () => {
		// ローヌは公的格付けが無く awards を持たない(辞書には解説だけがある)
		expect(getProducerAwardHighlight("Château de Beaucastel")).toBeUndefined();
		expect(getProducerAwardHighlight("存在しない生産者")).toBeUndefined();
	});
});

describe("sortProducersByAward", () => {
	it("受賞者を先頭へ寄せ、受賞なしは元の並びを保つ", () => {
		const sorted = sortProducersByAward([
			{ name: "無名の造り手A" },
			{ name: "Domaine Dujac" },
			{ name: "無名の造り手B" },
			{ name: "Domaine de la Romanée-Conti" },
		]);
		expect(sorted.map((p) => p.name)).toEqual([
			"Domaine de la Romanée-Conti", // 3グレープ
			"Domaine Dujac", // 2グレープ
			"無名の造り手A",
			"無名の造り手B",
		]);
	});

	it("同一制度内では階級順(3グレープ → 2 → 1 → 選出)に並ぶ", () => {
		const sorted = sortProducersByAward([
			{ name: "Domaine Berthaut-Gerbet" }, // 選出
			{ name: "Domaine Georges Roumier" }, // 3グレープ
			{ name: "Domaine Michel Lafarge" }, // 1グレープ
			{ name: "Domaine Dujac" }, // 2グレープ
		]);
		expect(
			sorted.map((p) => getProducerAwardHighlight(p.name)?.badgeJa),
		).toEqual(["3グレープ", "2グレープ", "1グレープ", "選出"]);
	});

	it("階級を持つ賞は階級を持たない賞より前に並ぶ", () => {
		const sorted = sortProducersByAward([
			{ name: "Accornero" }, // トレ・ビッキエーリ(階級なし)
			{ name: "無名の造り手" },
			{ name: "Château Palmer" }, // メドック格付け 第3級
		]);
		expect(sorted.map((p) => p.name)).toEqual([
			"Château Palmer",
			"Accornero",
			"無名の造り手",
		]);
	});

	it("同順位は元の並びを保つ(安定ソート)", () => {
		const names = ["Domaine Dujac", "Domaine Denis Mortet"]; // ともに2グレープ
		expect(
			sortProducersByAward(names.map((name) => ({ name }))).map((p) => p.name),
		).toEqual(names);
		expect(
			sortProducersByAward([...names].reverse().map((name) => ({ name }))).map(
				(p) => p.name,
			),
		).toEqual([...names].reverse());
	});

	it("入力配列を破壊しない", () => {
		const input = [{ name: "無名の造り手" }, { name: "Domaine Dujac" }];
		const before = input.map((p) => p.name);
		sortProducersByAward(input);
		expect(input.map((p) => p.name)).toEqual(before);
	});

	it("note などの付随フィールドを保ったまま並べ替える", () => {
		const sorted = sortProducersByAward([
			{ name: "無名の造り手", note: "協同組合" },
			{ name: "Domaine Dujac", note: "全房発酵" },
		]);
		expect(sorted[0]).toEqual({ name: "Domaine Dujac", note: "全房発酵" });
	});

	it("実データのAOPで受賞者が先頭に並ぶ", () => {
		// 受賞者と非受賞者が混在するAOPを実データから拾い、境界を1つも跨がないこと
		// (受賞者の後に非受賞者、その後にまた受賞者、が起きないこと)を確かめる
		const mixed = AOPS.filter((aop) => {
			const flags = aop.producers.map(
				(p) => getProducerAwardHighlight(p.name) !== undefined,
			);
			return flags.includes(true) && flags.includes(false);
		});
		expect(mixed.length).toBeGreaterThan(0);
		for (const aop of mixed) {
			const flags = sortProducersByAward(aop.producers).map(
				(p) => getProducerAwardHighlight(p.name) !== undefined,
			);
			const firstUnawarded = flags.indexOf(false);
			expect(flags.slice(firstUnawarded).some(Boolean), aop.id).toBe(false);
		}
	});
});
