import { describe, expect, it } from "vitest";
import { KIND_LABELS_JA } from "./map-style";
import { getAopKindLabelJa, getVineyardTermJa } from "./terminology";

// AOP区分の表示名の導出(#258)。以前は同じ三項式が詳細パネル×2・地図のポップアップ・
// 区分フィルタの4箇所に複製されており、地域固有呼称を持つ区分が増えたときに
// 直し漏れるとポップアップと詳細パネルで表記が食い違う。ここで導出を固定する。

describe("getAopKindLabelJa", () => {
	it("畑(vineyard)はブルゴーニュで「クリマ」", () => {
		expect(getAopKindLabelJa("vineyard", "bourgogne")).toBe("クリマ");
	});

	it("畑(vineyard)はアルザスで「リュー・ディ」", () => {
		expect(getAopKindLabelJa("vineyard", "alsace")).toBe("リュー・ディ");
	});

	it("地域固有呼称を持たない地域の畑は総称の「畑名」", () => {
		expect(getAopKindLabelJa("vineyard", "bordeaux")).toBe("畑名");
	});

	it("畑以外は地域に依らず総称ラベルを使う", () => {
		for (const regionId of ["bourgogne", "alsace", "bordeaux"]) {
			expect(getAopKindLabelJa("regional", regionId)).toBe(
				KIND_LABELS_JA.regional,
			);
			expect(getAopKindLabelJa("village", regionId)).toBe(
				KIND_LABELS_JA.village,
			);
			expect(getAopKindLabelJa("winery", regionId)).toBe(KIND_LABELS_JA.winery);
		}
	});

	it("畑の呼称は getVineyardTermJa と一致する(2系統に分かれない)", () => {
		for (const regionId of ["bourgogne", "alsace", "bordeaux", "champagne"]) {
			expect(getAopKindLabelJa("vineyard", regionId)).toBe(
				getVineyardTermJa(regionId),
			);
		}
	});
});
