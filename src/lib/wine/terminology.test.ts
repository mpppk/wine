import { describe, expect, it } from "vitest";
import { KIND_LABELS_JA } from "./map-style";
import { getAop } from "./service";
import { classificationPanelBadgeJa } from "./tags";
import {
	getAopKindLabelJa,
	getAppellationBadgeJa,
	getAppellationTermJa,
	getBoundarySourceNoteJa,
	getVineyardTermJa,
} from "./terminology";

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

// 原産地呼称制度の呼び名は国ごとに違う(仏 AOP/AOC・伊 DOC/DOCG・西 DO/DOCa)。
// 地域スコープの見出しとAOPのバッジで別々に実装するとドリフトするため、
// terminology の2関数に閉じていることをここで固定する。
describe("原産地呼称の総称・バッジ(国ごとの出し分け)", () => {
	it("見出しの総称は国ごとに変わる", () => {
		expect(getAppellationTermJa("bourgogne")).toBe("AOP");
		expect(getAppellationTermJa("piemonte")).toBe("DOC/DOCG");
		expect(getAppellationTermJa("toscana")).toBe("DOC/DOCG/IGT");
		// Vino de Pago は DO の階層の外にある独立したDOPなので総称にも並べる
		expect(getAppellationTermJa("rioja")).toBe("DO/DOCa/VP");
	});

	it("スペインのバッジはAOP単位のDOP階層で決まる", () => {
		const badge = (id: string) => {
			const aop = getAop(id);
			if (!aop) throw new Error(`unknown aop: ${id}`);
			return getAppellationBadgeJa(aop);
		};
		expect(badge("rioja")).toBe("DOCa");
		expect(badge("navarra")).toBe("DO");
		expect(badge("somontano")).toBe("DO");
		expect(badge("pago-de-arinzano")).toBe("VP");
		expect(badge("ayles")).toBe("VP");
		// 他国は従来どおり
		expect(badge("chablis")).toBe("AOC");
		expect(badge("barolo")).toBe("DOC/DOCG");
	});

	// #212 の IGT と同じ理由: 呼称名そのものを表すタグは、格付けバッジ側では
	// 出さない(詳細パネルに同じ文字列が2つ並ぶ)。
	it("呼称名を表すタグは格付けバッジとして重複表示しない", () => {
		const panelBadge = (id: string) => {
			const aop = getAop(id);
			if (!aop) throw new Error(`unknown aop: ${id}`);
			return classificationPanelBadgeJa(aop);
		};
		expect(panelBadge("rioja")).toBeUndefined();
		expect(panelBadge("somontano")).toBeUndefined();
		expect(panelBadge("pago-de-arinzano")).toBeUndefined();
		expect(panelBadge("toscana-igt")).toBeUndefined();
		// イタリアの DOCG/DOC は呼称バッジ("DOC/DOCG")と文言が異なるので従来どおり出す
		expect(panelBadge("barolo")).toBe("DOCG");
	});

	it("EU PDOデータセット由来の国は境界の出典注記が共通", () => {
		const note = (id: string) => {
			const aop = getAop(id);
			if (!aop) throw new Error(`unknown aop: ${id}`);
			return getBoundarySourceNoteJa(aop);
		};
		expect(note("rioja")).toBe(note("barolo"));
		expect(note("rioja")).toContain("EU PDO境界データ");
		expect(note("chablis")).not.toContain("EU PDO境界データ");
	});
});
