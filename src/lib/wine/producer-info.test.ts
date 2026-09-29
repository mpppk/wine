import { describe, expect, it } from "vitest";
import { AOPS } from "./aops-data";
import {
	findProducerInfoByName,
	getProducerAwardHighlight,
	sortProducersByAward,
} from "./producer-info";

// 生産者リストの「受賞者を上位に・受賞歴をタップ前に見せる」表示ロジック。
// 辞書(PRODUCER_INFO)の実データを使う。実在の生産者名を参照するため、辞書から
// エントリが消えるとテストが落ちる(意図した削除ならテスト側も直す)。

describe("findProducerInfoByName", () => {
	it("完全一致・表記揺れ(アクセント/大小文字)は従来どおり引ける", () => {
		expect(findProducerInfoByName("Domaine de la Romanée-Conti")?.name).toBe(
			"Domaine de la Romanée-Conti",
		);
		expect(findProducerInfoByName("domaine de la romanee conti")?.name).toBe(
			"Domaine de la Romanée-Conti",
		);
		expect(findProducerInfoByName("Château Margaux")?.name).toBe(
			"Château Margaux",
		);
	});

	// #492: モデルが正式表記へ正して足す接尾辞は剥がして辞書を引く。
	// 実データの `Domaine Armand Rousseau`(MICHELIN 1グレープ)を使う。
	it.each([
		"Domaine Armand Rousseau Père et Fils",
		"Domaine Armand Rousseau et Fils",
		"Domaine Armand Rousseau & Fils",
		"Domaine Armand Rousseau SARL",
		"Domaine Armand Rousseau S.A.S.",
		"Domaine Armand Rousseau S.r.l.",
		"Domaine Armand Rousseau Estate",
		"Domaine Armand Rousseau Winery",
	])("%s は辞書の Domaine Armand Rousseau を引く", (extracted) => {
		expect(findProducerInfoByName(extracted)?.name).toBe(
			"Domaine Armand Rousseau",
		);
	});

	it("辞書キー自体が接尾辞を含む生産者にも接尾辞を重ねて引ける", () => {
		// `Domaine Trapet Père et Fils` は辞書キー。法人格がさらに付いても引ける
		expect(
			findProducerInfoByName("Domaine Trapet Père et Fils SARL")?.name,
		).toBe("Domaine Trapet Père et Fils");
	});

	// #471 の判断は維持: 単なる前方一致では引かない(残りが地名・畑名など)。
	it("残りが既知接尾辞でなければ引かない", () => {
		expect(
			findProducerInfoByName("Domaine Armand Rousseau Gevrey-Chambertin"),
		).toBeUndefined();
		expect(
			findProducerInfoByName("Domaine Armand Rousseau Grand Cru"),
		).toBeUndefined();
	});

	// 逆向き(抽出名のほうが短い)は引かない。情報が減る方向は取り違えやすい。
	it("抽出名が辞書キーより短い逆向きは引かない", () => {
		// 辞書には `Domaine Trapet Père et Fils` があるが `Domaine Trapet` は無い
		expect(findProducerInfoByName("Domaine Trapet")).toBeUndefined();
	});

	// #471 の回帰条件: 別の生産者を取り違えない。
	it("別の生産者を取り違えない", () => {
		// `Margaux` だけでは `Château Margaux` を掴まない
		expect(findProducerInfoByName("Margaux")).toBeUndefined();
		// `Léoville Barton` は辞書に無く、`Léoville Las Cases` とも混同しない
		expect(findProducerInfoByName("Léoville Barton")).toBeUndefined();
		expect(findProducerInfoByName("Chateau Leoville Las Cases")?.name).toBe(
			"Château Léoville-Las Cases",
		);
	});

	it("空文字は引かない", () => {
		expect(findProducerInfoByName("")).toBeUndefined();
		expect(findProducerInfoByName("   ")).toBeUndefined();
	});
});

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
