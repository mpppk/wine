import { describe, expect, it } from "vitest";
import { isMapTapExcludedAop, pickTopFeature } from "./map-style";
import type { Aop } from "./types";

function aop(
	partial: Partial<Aop> & Pick<Aop, "id" | "idApp" | "kind" | "subregionId">,
): Aop {
	return {
		name: partial.id,
		shortName: partial.id,
		nameJa: partial.id,
		region: "bordeaux",
		colors: ["red"],
		grapes: [{ varietyId: "merlot", role: "principal" }],
		soil: "-",
		producers: [{ name: "-" }],
		description: "-",
		...partial,
	};
}

// #584 の再現に対応するボルドーの顔ぶれ(抜粋)
const BORDEAUX = aop({
	id: "bordeaux",
	idApp: 910001,
	kind: "regional",
	subregionId: "bordeaux-regional",
});
const BORDEAUX_SUPERIEUR = aop({
	id: "bordeaux-superieur",
	idApp: 910002,
	kind: "regional",
	subregionId: "bordeaux-regional",
});
// 地区級の regional(実在の地区の地理を持つ)は除外しない
const MEDOC = aop({
	id: "medoc",
	idApp: 910003,
	kind: "regional",
	subregionId: "medoc",
});
const PAUILLAC = aop({
	id: "pauillac",
	idApp: 910101,
	kind: "village",
	subregionId: "medoc",
});
const LATOUR = aop({
	id: "chateau-latour",
	idApp: 910102,
	kind: "winery",
	subregionId: "medoc",
});

function byIdApp(...aops: Aop[]): Map<number, Aop> {
	return new Map(aops.map((a) => [a.idApp, a]));
}

describe("isMapTapExcludedAop", () => {
	it("ボルドー広域(id=bordeaux)を除外する", () => {
		expect(isMapTapExcludedAop(BORDEAUX)).toBe(true);
	});
	it("*-regional 置き場の広域AOCを除外する(他地方へ一般化)", () => {
		expect(isMapTapExcludedAop(BORDEAUX_SUPERIEUR)).toBe(true);
		expect(
			isMapTapExcludedAop(
				aop({
					id: "champagne",
					idApp: 1,
					kind: "regional",
					subregionId: "champagne-regional",
				}),
			),
		).toBe(true);
		expect(
			isMapTapExcludedAop(
				aop({
					id: "bourgogne",
					idApp: 2,
					kind: "regional",
					subregionId: "bourgogne-regional",
				}),
			),
		).toBe(true);
	});
	it("地区級の regional・村名・シャトーは除外しない", () => {
		expect(isMapTapExcludedAop(MEDOC)).toBe(false);
		expect(isMapTapExcludedAop(PAUILLAC)).toBe(false);
		expect(isMapTapExcludedAop(LATOUR)).toBe(false);
	});
});

describe("pickTopFeature", () => {
	const all = byIdApp(
		BORDEAUX,
		BORDEAUX_SUPERIEUR,
		MEDOC,
		PAUILLAC,
		LATOUR,
	);
	it("広域と村名が重なったら村名を選ぶ(#584)", () => {
		expect(
			pickTopFeature([{ id: BORDEAUX.idApp }, { id: PAUILLAC.idApp }], all)
				?.id,
		).toBe("pauillac");
	});
	it("広域だけしか重ならなければ何も選ばない", () => {
		expect(pickTopFeature([{ id: BORDEAUX.idApp }], all)).toBeUndefined();
		expect(
			pickTopFeature(
				[{ id: BORDEAUX.idApp }, { id: BORDEAUX_SUPERIEUR.idApp }],
				all,
			),
		).toBeUndefined();
	});
	it("地区級 regional は引き続き選ばれる", () => {
		expect(
			pickTopFeature([{ id: BORDEAUX.idApp }, { id: MEDOC.idApp }], all)
				?.id,
		).toBe("medoc");
	});
	it("区分ランク順と同ランクの決定的選択を維持する", () => {
		// 畑 > 村名
		const vineyard = aop({
			id: "les-forts",
			idApp: 910201,
			kind: "vineyard",
			subregionId: "medoc",
		});
		const m = byIdApp(PAUILLAC, vineyard);
		expect(
			pickTopFeature([{ id: PAUILLAC.idApp }, { id: vineyard.idApp }], m)
				?.id,
		).toBe("les-forts");
		// 同ランクは idApp 昇順
		const v2 = aop({
			...vineyard,
			id: "other-vineyard",
			idApp: 910202,
		});
		const m2 = byIdApp(vineyard, v2);
		expect(
			pickTopFeature([{ id: v2.idApp }, { id: vineyard.idApp }], m2)?.id,
		).toBe("les-forts");
	});
	it("未知の idApp・空配列は無視する", () => {
		expect(pickTopFeature([], all)).toBeUndefined();
		expect(pickTopFeature([{ id: 999999999 }], all)).toBeUndefined();
	});
	it("文字列の feature id でも解決して除外する", () => {
		expect(
			pickTopFeature(
				[{ id: String(BORDEAUX.idApp) }, { id: PAUILLAC.idApp }],
				all,
			)?.id,
		).toBe("pauillac");
	});
});
