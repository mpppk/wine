import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { buildWineDetailRows } from "./wine-detail";

// 閲覧専用画面(/cellar/$entryId)に並ぶ項目の規約:
//  - 値が無い項目は行ごと落とす(状態だけは常に出る)
//  - ID(地域・AOP・ぶどう品種)は静的マスタを引いて日本語名で出す
//  - 未購入(wishlist)では価格を出さない(編集フォームが入力欄を隠す条件と揃える)
//  - 産地(地域・AOP)の行だけは産地の学習地図への遷移先(link)を持つ

const BASE: DrunkWineEntry = {
	id: "e1",
	name: "テストワイン",
	status: "finished",
	lastDrankOn: null,
	tastingCount: 0,
	lastSeenOn: null,
	sightingCount: 0,
	aopId: null,
	aopNameJa: null,
	regionId: null,
	countryId: null,
	lastRating: null,
	lastMemo: null,
	vintage: null,
	grapeVarietyIds: [],
	producer: null,
	note: null,
	price: null,
	photoUrls: [],
	thumbUrls: [],
	photoKinds: [],
	createdAt: 0,
	updatedAt: 0,
};

/** ラベル→値の辞書にして、行の有無と中身を素直に検査できるようにする */
function rowMap(entry: DrunkWineEntry): Map<string, string> {
	return new Map(buildWineDetailRows(entry).map((r) => [r.label, r.value]));
}

/** 遷移先(link)まで見たいとき用。行そのものを引く */
function rowOf(entry: DrunkWineEntry, label: string) {
	return buildWineDetailRows(entry).find((r) => r.label === label);
}

describe("buildWineDetailRows", () => {
	it("値が無い項目は行を作らず、状態だけを返す", () => {
		expect(buildWineDetailRows(BASE)).toEqual([
			{ label: "状態", value: "飲んだ" },
		]);
	});

	it("ヴィンテージ・生産者・価格を表示用に整形する", () => {
		const rows = rowMap({
			...BASE,
			vintage: 2020,
			producer: "ドメーヌ・ルフレーヴ",
			price: 12345,
		});
		expect(rows.get("ヴィンテージ")).toBe("2020年");
		expect(rows.get("生産者")).toBe("ドメーヌ・ルフレーヴ");
		expect(rows.get("価格")).toBe("¥12,345");
	});

	it("未購入(wishlist)では価格を出さない", () => {
		const rows = rowMap({ ...BASE, status: "wishlist", price: 5000 });
		expect(rows.get("状態")).toBe("気になる");
		expect(rows.get("価格")).toBeUndefined();
	});

	it("地域・AOP・ぶどう品種をマスタの日本語名で出す", () => {
		const rows = rowMap({
			...BASE,
			regionId: "bourgogne",
			aopId: "chablis",
			aopNameJa: "シャブリ",
			grapeVarietyIds: ["chardonnay", "pinot-noir"],
		});
		expect(rows.get("地域")).toBe("ブルゴーニュ");
		expect(rows.get("AOP")).toBe("シャブリ");
		expect(rows.get("ぶどう品種")).toBe("シャルドネ、ピノ・ノワール");
	});

	it("aopNameJa が欠けていても aopId から名前を引く", () => {
		const rows = rowMap({ ...BASE, aopId: "chablis", aopNameJa: null });
		expect(rows.get("AOP")).toBe("シャブリ");
	});

	it("マスタに無いぶどう品種IDは落とす", () => {
		const rows = rowMap({
			...BASE,
			grapeVarietyIds: ["chardonnay", "no-such-variety"],
		});
		expect(rows.get("ぶどう品種")).toBe("シャルドネ");
	});
});

// 産地の行から地図へ飛べるようにした導線。「どの行がどこを指すか」を
// ここで固定する。表示側(cellar.$entryId.index.tsx)は link の有無だけを見る。
describe("産地の学習地図へのリンク", () => {
	afterEach(() => {
		vi.doUnmock("#/lib/wine/service");
		vi.resetModules();
	});

	it("AOP行は、そのAOPを選択した状態の地図を指す", () => {
		const row = rowOf(
			{
				...BASE,
				regionId: "bourgogne",
				aopId: "chablis",
				aopNameJa: "シャブリ",
			},
			"AOP",
		);
		expect(row?.link).toEqual({ regionId: "bourgogne", aopId: "chablis" });
	});

	it("地域行は、AOPを選択しない地域全体の地図を指す", () => {
		const row = rowOf({ ...BASE, regionId: "bourgogne" }, "地域");
		expect(row?.link).toEqual({ regionId: "bourgogne" });
	});

	it("退役IDで保存された行は、後継AOPのIDでリンクする", () => {
		// 地図側は現行IDでしか選択できないので、保存値のままでは何も選択されない(#333)
		const row = rowOf(
			{
				...BASE,
				regionId: "bordeaux",
				aopId: "chateau-la-gaffeliere",
				aopNameJa: null,
			},
			"AOP",
		);
		expect(row?.link).toEqual({
			regionId: "bordeaux",
			aopId: "saint-emilion-grand-cru",
		});
	});

	it("マスタから消えて名前だけ残ったAOPの行はリンクにしない", () => {
		// aopNameJa はサーバ由来なので行自体は出るが、地図では選択できない
		const row = rowOf(
			{ ...BASE, aopId: "no-such-aop", aopNameJa: "幻のAOP" },
			"AOP",
		);
		expect(row?.value).toBe("幻のAOP");
		expect(row?.link).toBeUndefined();
	});

	it("産地以外の行はリンクを持たない", () => {
		const rows = buildWineDetailRows({
			...BASE,
			vintage: 2020,
			producer: "ドメーヌ・ルフレーヴ",
			price: 12345,
			grapeVarietyIds: ["chardonnay"],
		});
		expect(rows.every((r) => r.link === undefined)).toBe(true);
	});

	it("準備中(enabled=false)の地域はリンクにしない", async () => {
		// /map/$regionId が /regions へリダイレクトするため、押しても産地が出ない。
		// 現在のマスタは全地域 enabled なので、地域追加時の規約をモックで固定する
		vi.resetModules();
		vi.doMock("#/lib/wine/service", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("#/lib/wine/service")>();
			return {
				...actual,
				getRegion: (id: string) => {
					const region = actual.getRegion(id);
					return region ? { ...region, enabled: false } : region;
				},
			};
		});
		const { buildWineDetailRows: build } = await import("./wine-detail");

		const rows = build({
			...BASE,
			regionId: "bourgogne",
			aopId: "chablis",
			aopNameJa: "シャブリ",
		});
		expect(rows.find((r) => r.label === "地域")?.link).toBeUndefined();
		expect(rows.find((r) => r.label === "AOP")?.link).toBeUndefined();
	});
});
