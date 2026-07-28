import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCER_SEARCH_KEYWORDS } from "./affiliate";
import { aopArraySchema } from "./aop-schema";
import rawAops from "./aops.json";
import { AOPS } from "./aops-data";
import {
	MICHELIN_GRAPES_URL,
	PRODUCER_INFO,
	type ProducerAward,
} from "./producer-info";
import { REGION_IDS, REGIONS } from "./regions";
import type { Aop } from "./types";
import { POLYGONLESS_IDAPP_MIN, REGION_ID_LIST } from "./types";

// aops.json と public/data/aop/*.geojson の整合性を検証する。
// aops.json のスキーマ検証はかつて aops-data.ts の読み込み時(=全ページの初期ロード)に
// 行われていたが、コールドスタートのコストになるためランタイムから外した(#32)。
// 代わりに以下のテストで検証し、壊れたデータをデプロイ前(CI)に検出する。

describe("aops.json のスキーマ検証(#32: ランタイムからテストへ移設)", () => {
	it("aops.json 全件が aopArraySchema を満たす", () => {
		// throw されると詳細なパスが出るよう parse をそのまま実行する
		expect(() => aopArraySchema.parse(rawAops)).not.toThrow();
	});
});

describe("地域マスタ(REGIONS)とRegionId SSOTの整合性", () => {
	it("REGIONS の id 集合が REGION_ID_LIST と過不足なく一致する", () => {
		const regionIds = REGIONS.map((r) => r.id).sort();
		const listIds = [...REGION_ID_LIST].sort();
		expect(regionIds).toEqual(listIds);
	});

	it("REGIONS の id に重複が無い", () => {
		const regionIds = REGIONS.map((r) => r.id);
		expect(new Set(regionIds).size).toBe(regionIds.length);
	});

	it("REGION_IDS は REGION_ID_LIST を参照している", () => {
		expect([...REGION_IDS]).toEqual([...REGION_ID_LIST]);
	});
});

describe("AOPメタデータの整合性", () => {
	it("スラッグとidAppが一意", () => {
		const ids = AOPS.map((a) => a.id);
		const idApps = AOPS.map((a) => a.idApp);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(idApps).size).toBe(idApps.length);
	});

	it("regionとsubregionIdが地域マスタに存在する", () => {
		for (const aop of AOPS) {
			const region = REGIONS.find((r) => r.id === aop.region);
			expect(region, `region ${aop.region} (${aop.id})`).toBeDefined();
			expect(
				region?.subregions.some((s) => s.id === aop.subregionId),
				`subregion ${aop.subregionId} (${aop.id})`,
			).toBe(true);
		}
	});

	it("1つのAOPは格付けタグを高々1つしか持たない", () => {
		// 制度が異なっても、格付けは1AOPにつき1つ(特級かつ一級のような併持は無い)
		for (const aop of AOPS) {
			expect((aop.tags ?? []).length, aop.id).toBeLessThanOrEqual(1);
		}
	});

	it("畑・シャトーの親AOC参照が有効", () => {
		const byId = new Map(AOPS.map((a) => [a.id, a]));
		// 村名AOCを持つ地域では畑は必ず親村を参照する。アルザスのように
		// 村名AOC自体が存在しない地域の畑は villageAopIds を持たない。
		const regionsWithVillages = new Set(
			AOPS.filter((a) => a.kind === "village").map((a) => a.region),
		);
		// 個別クリマ(parentAopId を持つ畑)は親畑を参照し、村は親から導出するため
		// villageAopIds を持たない。トップレベルの畑だけが村を参照する。
		for (const aop of AOPS.filter(
			(a) => a.kind === "vineyard" && a.parentAopId,
		)) {
			expect(aop.villageAopIds, aop.id).toBeUndefined();
			const parent = aop.parentAopId ? byId.get(aop.parentAopId) : undefined;
			expect(parent, `${aop.id} -> ${aop.parentAopId}`).toBeDefined();
			expect(parent?.kind, `${aop.id} -> ${aop.parentAopId}`).toBe("vineyard");
			expect(parent?.region, `${aop.id} -> ${aop.parentAopId}`).toBe(
				aop.region,
			);
		}
		for (const aop of AOPS.filter(
			(a) => a.kind === "vineyard" && !a.parentAopId,
		)) {
			if (regionsWithVillages.has(aop.region)) {
				expect(aop.villageAopIds?.length, aop.id).toBeGreaterThan(0);
			} else {
				expect(aop.villageAopIds, aop.id).toBeUndefined();
			}
			for (const villageId of aop.villageAopIds ?? []) {
				const village = byId.get(villageId);
				expect(village, `${aop.id} -> ${villageId}`).toBeDefined();
				expect(village?.kind, `${aop.id} -> ${villageId}`).toBe("village");
				expect(village?.region, `${aop.id} -> ${villageId}`).toBe(aop.region);
			}
		}
		// シャトーはちょうど1つの親を持つ。親は村名AOCまたは地区AOC(オー・メドック等)
		for (const aop of AOPS.filter((a) => a.kind === "winery")) {
			expect(aop.villageAopIds?.length, aop.id).toBe(1);
			const parentId = aop.villageAopIds?.[0];
			const parent = parentId ? byId.get(parentId) : undefined;
			expect(parent, `${aop.id} -> ${parentId}`).toBeDefined();
			expect(["village", "regional"], `${aop.id} -> ${parentId}`).toContain(
				parent?.kind,
			);
			expect(parent?.region, `${aop.id} -> ${parentId}`).toBe(aop.region);
		}
	});

	it("villageAopIds は畑(vineyard)とシャトー(winery)のみが持つ", () => {
		for (const aop of AOPS.filter(
			(a) => a.kind !== "vineyard" && a.kind !== "winery",
		)) {
			expect(aop.villageAopIds, aop.id).toBeUndefined();
		}
	});

	it("移行後の件数スナップショット(区分・タグ)", () => {
		// 旧 classification/premierCru からの移行が欠落なく行われたことの回帰チェック。
		// 個別クリマ(Chablis GC 7 + Chablis 1er 17 + Corton 8)と合成総称ノード
		// (Chablis Premier Cru)を畑として追加したぶん、件数を更新している。
		const vineyards = AOPS.filter((a) => a.kind === "vineyard");
		expect(vineyards.length).toBe(117);
		expect(vineyards.filter((a) => a.region === "bourgogne").length).toBe(66);
		expect(vineyards.filter((a) => a.region === "alsace").length).toBe(51);
		// grand-cru: ブルゴーニュ+アルザス116 + ロワール唯一のGCケール・ド・ショーム1
		expect(AOPS.filter((a) => a.tags?.includes("grand-cru")).length).toBe(117);
		expect(AOPS.filter((a) => a.tags?.includes("premier-cru")).length).toBe(91);
	});

	it("個別クリマ/合成総称ノードはポリゴンを持たない帯(idApp>=930000)にある", () => {
		// ジオメトリ/重心の生成・整合チェックはこの帯を対象外にする(下記GeoJSONテスト)
		for (const aop of AOPS.filter((a) => a.parentAopId)) {
			expect(aop.idApp, aop.id).toBeGreaterThanOrEqual(POLYGONLESS_IDAPP_MIN);
			expect(aop.isAppellation, aop.id).toBe(false);
		}
	});

	it("ボルドー: シャトー(winery)の件数と格付けの内訳", () => {
		const wineries = AOPS.filter((a) => a.kind === "winery");
		// 101(#216 で La Gaffelière を producers へ移した後) + グラーヴ1959年格付け13
		// + La Mondotte 1 = 115。
		expect(wineries.length).toBe(115);
		expect(wineries.every((a) => a.region === "bordeaux")).toBe(true);
		const countTag = (t: string) =>
			AOPS.filter((a) => a.tags?.includes(t as never)).length;
		// メドック1855: 1級5+ソーテルヌ1級11=16 / 2級14+15=29 / 3級14 / 4級10 / 5級18
		expect(countTag("premier-cru-superieur-1855")).toBe(1); // イケム
		expect(countTag("premier-cru-classe-1855")).toBe(16);
		expect(countTag("deuxieme-cru-classe-1855")).toBe(29);
		expect(countTag("troisieme-cru-classe-1855")).toBe(14);
		expect(countTag("quatrieme-cru-classe-1855")).toBe(10);
		expect(countTag("cinquieme-cru-classe-1855")).toBe(18);
		// サンテミリオン2022 1er GCC。公式の内訳は A 2件 / B 12件。
		expect(countTag("premier-grand-cru-classe-a")).toBe(2);
		expect(countTag("premier-grand-cru-classe-b")).toBe(12);
		// グラーヴ1959年格付けは全16件。うち Haut-Brion は1855年第1級として既収録、
		// La Tour Haut-Brion(2004年最終) と Laville Haut-Brion(2008年最終・
		// La Mission Haut-Brion Blanc に改名) は現存しないため載せない。
		expect(countTag("cru-classe-de-graves")).toBe(13);
	});

	// 2022年格付けの B に La Gaffelière(2022年に離脱)が混ざっていた不具合の回帰防止。
	// 公式(サンテミリオンワイン評議会)の一覧と突き合わせて名前を固定する。
	it("サンテミリオン第1特別級は公式の顔ぶれと一致する", () => {
		const namesOf = (tag: string) =>
			AOPS.filter((a) => a.tags?.includes(tag as never))
				.map((a) => a.name)
				.sort();
		expect(namesOf("premier-grand-cru-classe-a")).toEqual([
			"Château Figeac",
			"Château Pavie",
		]);
		expect(namesOf("premier-grand-cru-classe-b")).toEqual([
			"Château Beau-Séjour Bécot",
			"Château Beauséjour (Héritiers Duffau-Lagarrosse)",
			"Château Bélair-Monange",
			"Château Canon",
			"Château Canon la Gaffelière",
			"Château Larcis Ducasse",
			"Château Pavie Macquin",
			"Château Troplong Mondot",
			"Château Trottevieille",
			"Château Valandraud",
			"Clos Fourtet",
			"La Mondotte",
		]);
	});

	// サンテミリオン格付けの Grands Crus Classés は2022年版で71件。公式一覧を
	// 数えた値で、公式ページの本文や二次情報が「66」「62」と述べることがあるが
	// 列挙されている名前は71ある。件数の記述ではなくリストを信用すること。
	// Premiers(A2 + B12)は winery、GCC は producers に置く(#209 の規約。winery に
	// すると aop-classification クイズが単一ラベル71件に偏る)。
	it("サンテミリオン・グラン・クリュの producers に GCC 71件が入っている", () => {
		const segc = AOPS.find((a) => a.id === "saint-emilion-grand-cru");
		const names = new Set(segc?.producers.map((p) => p.name));
		// Premiers A の2件 + 格付けを離脱した La Gaffelière(#216) + GCC 71 = 75
		expect(names.size).toBe(75);
		for (const n of ["Château Soutard", "Clos des Jacobins", "Lassegue"]) {
			expect(names.has(n), n).toBe(true);
		}
		// Premiers は winery 側にあるので producers に重複させない
		expect(names.has("La Mondotte")).toBe(false);
	});

	// クリュ・ブルジョワは**2025年格付け**の Exceptionnel 14件だけを載せる
	// (Supérieur 36件・通常級120件は載せない。#209 の意図的な線引き)。
	// Wikipedia 等が載せているのは2020年版で、2025年版とは14件中8件が別物。
	// 公式PDFの一覧で AOC ごとの内訳まで確認した値を固定する。
	it("クリュ・ブルジョワ Exceptionnel 2025 が AOC ごとに正しく入っている", () => {
		const producersOf = (id: string) =>
			new Set(AOPS.find((a) => a.id === id)?.producers.map((p) => p.name));
		const expected: Record<string, string[]> = {
			medoc: ["Château la Cardonne", "Château Castera", "Château Laujac"],
			"haut-medoc": [
				"Château Malescasse",
				"Château de Malleret",
				"Château Paloumey",
				"Château Reysson",
				"Château du Taillan",
			],
			"listrac-medoc": ["Château Reverdi"],
			margaux: [
				"Château d'Arsac",
				"Château Mongravey",
				"Château Paveil de Luze",
			],
			"saint-estephe": ["Château le Crock", "Château Laffitte Carcasset"],
		};
		let total = 0;
		for (const [aopId, names] of Object.entries(expected)) {
			const have = producersOf(aopId);
			for (const n of names) expect(have?.has(n), `${aopId}: ${n}`).toBe(true);
			total += names.length;
		}
		expect(total).toBe(14);
	});

	// グラーヴ1959年格付けの顔ぶれ。現存しない2件を足し戻さないための固定。
	it("グラーヴ格付けは現存する13件と一致する", () => {
		const names = AOPS.filter((a) =>
			a.tags?.includes("cru-classe-de-graves" as never),
		)
			.map((a) => a.name)
			.sort();
		expect(names).toEqual([
			"Château Bouscaut",
			"Château Carbonnieux",
			"Château Couhins",
			"Château Couhins-Lurton",
			"Château Haut-Bailly",
			"Château La Mission Haut-Brion",
			"Château Latour-Martillac",
			"Château Malartic-Lagravière",
			"Château Olivier",
			"Château Pape Clément",
			"Château Smith Haut Lafitte",
			"Château de Fieuzal",
			"Domaine de Chevalier",
		]);
	});

	it("ボルドー1855/サンテミリオン格付けタグは winery のみが持つ", () => {
		const wineryTags = new Set([
			"premier-cru-superieur-1855",
			"premier-cru-classe-1855",
			"deuxieme-cru-classe-1855",
			"troisieme-cru-classe-1855",
			"quatrieme-cru-classe-1855",
			"cinquieme-cru-classe-1855",
			"premier-grand-cru-classe-a",
			"premier-grand-cru-classe-b",
		]);
		for (const aop of AOPS) {
			if ((aop.tags ?? []).some((t) => wineryTags.has(t))) {
				expect(aop.kind, aop.id).toBe("winery");
			}
		}
	});

	it("主要品種(principal)が少なくとも1つある", () => {
		for (const aop of AOPS) {
			expect(
				aop.grapes.some((g) => g.role === "principal"),
				aop.id,
			).toBe(true);
		}
	});
});

/** Gambero Rosso トレ・ビッキエーリの受賞かどうか */
const isTreBicchieri = (award: ProducerAward): boolean =>
	award.name.includes("トレ・ビッキエーリ");

describe("生産者情報(PRODUCER_INFO)の整合性", () => {
	// 全AOPに登場する生産者名の集合。PRODUCER_INFO のキーはここに含まれていないと
	// ダイアログで表示されず、表記ゆれの温床になるため参照整合性を検証する。
	const producerNames = new Set(
		AOPS.flatMap((a) => a.producers.map((p) => p.name)),
	);

	it("PRODUCER_INFO のキーは aops.json の生産者名に存在する", () => {
		for (const name of Object.keys(PRODUCER_INFO)) {
			expect(producerNames.has(name), name).toBe(true);
		}
	});

	it("公式サイトは有効なURL。説明文はあるなら非空", () => {
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			if (info.description !== undefined) {
				expect(info.description.length, name).toBeGreaterThan(0);
			}
			if (info.officialWebsite !== undefined) {
				expect(
					() => new URL(info.officialWebsite as string),
					name,
				).not.toThrow();
				expect(info.officialWebsite, name).toMatch(/^https?:\/\//);
			}
		}
	});

	// description は任意なので、両方無いとダイアログが生産者名と購入リンクだけになる。
	// 受賞も解説も持たないなら PRODUCER_INFO に登録する意味がない。
	it("説明文と受賞の少なくとも一方を持つ", () => {
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			const hasAward = (info.awards?.length ?? 0) > 0;
			expect(info.description !== undefined || hasAward, name).toBe(true);
		}
	});

	it("MICHELIN Grapes 記事URLは michelin.com の有効な https URL", () => {
		expect(() => new URL(MICHELIN_GRAPES_URL)).not.toThrow();
		const url = new URL(MICHELIN_GRAPES_URL);
		expect(url.protocol).toBe("https:");
		expect(url.hostname).toMatch(/(^|\.)michelin\.com$/);
	});

	// 受賞は生産者ごとに持つ(#202)。「解説があれば MICHELIN Grapes 選出」という
	// 既定を復活させると、ブルゴーニュ以外の生産者に誤った受賞が表示される。
	it("各エントリの受賞は名称・妥当な年・有効な https URL を持つ", () => {
		// 未来の年や、公的格付けの最古(1855年メドック)より前の年を弾く
		const maxYear = new Date().getFullYear() + 1;
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			for (const award of info.awards ?? []) {
				expect(award.name.length, name).toBeGreaterThan(0);
				expect(award.year, name).toBeGreaterThanOrEqual(1855);
				expect(award.year, name).toBeLessThanOrEqual(maxYear);
				if (award.url !== undefined) {
					expect(() => new URL(award.url as string), name).not.toThrow();
					expect(award.url, name).toMatch(/^https:\/\//);
				}
			}
		}
	});

	// 公的格付けの awards は、格付けを持つシャトーのうち producers 配列にも
	// 名前が載っているものだけに付く(winery 側は tags からバッジが出る)。
	// 1855年とグラーヴは授与元にこの環境から到達できないため url を持たない。
	it("ボルドーの公的格付けを awards に持つ生産者の内訳", () => {
		const byLabel = new Map<string, number>();
		for (const info of Object.values(PRODUCER_INFO)) {
			for (const a of info.awards ?? []) {
				if (a.year !== 1855 && a.year !== 1959 && a.year !== 2022) continue;
				byLabel.set(
					`${a.name} ${a.tier}`,
					(byLabel.get(`${a.name} ${a.tier}`) ?? 0) + 1,
				);
			}
		}
		expect(Object.fromEntries(byLabel)).toEqual({
			"メドック格付け 第1級": 5,
			"メドック格付け 第2級": 6,
			"メドック格付け 第3級": 3,
			"メドック格付け 第5級": 1,
			"ソーテルヌ・バルサック格付け 特別第1級": 1,
			"ソーテルヌ・バルサック格付け 第1級": 4,
			"グラーヴ格付け クリュ・クラッセ": 2,
			"サンテミリオン格付け 第1特別級A": 2,
		});
	});

	// awards の tier は winery 側の格付けタグと食い違ってはいけない。
	// 片方だけ直して不整合になるのを防ぐ。
	it("公的格付けの awards は winery のタグと一致する", () => {
		const TIER_BY_TAG: Record<string, string> = {
			"premier-cru-superieur-1855": "特別第1級",
			"premier-cru-classe-1855": "第1級",
			"deuxieme-cru-classe-1855": "第2級",
			"troisieme-cru-classe-1855": "第3級",
			"quatrieme-cru-classe-1855": "第4級",
			"cinquieme-cru-classe-1855": "第5級",
			"cru-classe-de-graves": "クリュ・クラッセ",
			"premier-grand-cru-classe-a": "第1特別級A",
		};
		const tagOf = new Map(
			AOPS.filter((a) => a.kind === "winery" && a.tags?.length).map((a) => [
				a.name,
				a.tags?.[0] as string,
			]),
		);
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			for (const a of info.awards ?? []) {
				if (a.year !== 1855 && a.year !== 1959 && a.year !== 2022) continue;
				const tag = tagOf.get(name);
				expect(tag, name).toBeDefined();
				expect(a.tier, name).toBe(TIER_BY_TAG[tag as string]);
			}
		}
	});

	it("MICHELIN Grapes を受賞に持つのはブルゴーニュの生産者だけ", () => {
		const bourgogneProducers = new Set(
			AOPS.filter((a) => a.region === "bourgogne").flatMap((a) =>
				a.producers.map((p) => p.name),
			),
		);
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			if (!info.awards?.some((a) => a.url === MICHELIN_GRAPES_URL)) continue;
			expect(bourgogneProducers.has(name), name).toBe(true);
		}
	});

	// 公式記事が「94 estates のうち9件が最上位の Three Grapes」と明記している。
	// 階級の付け替えでこの内訳が崩れたら、記事と食い違う表示になる。
	it("MICHELIN Grapes の階級内訳が公式記事の94件と一致する", () => {
		const byTier = new Map<string, number>();
		for (const info of Object.values(PRODUCER_INFO)) {
			for (const award of info.awards ?? []) {
				if (award.url !== MICHELIN_GRAPES_URL) continue;
				const tier = award.tier ?? "(なし)";
				byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
			}
		}
		expect(Object.fromEntries(byTier)).toEqual({
			"3グレープ": 9,
			"2グレープ": 20,
			"1グレープ": 33,
			選出: 32,
		});
	});

	// MICHELIN Grapes のブルゴーニュ限定と対になる制約。トレ・ビッキエーリは
	// イタリア2地域の生産者にしか付かない(地域を跨いだ誤付与を防ぐ)。
	it("トレ・ビッキエーリを受賞に持つのはピエモンテ/トスカーナの生産者だけ", () => {
		const italyProducers = new Set(
			AOPS.filter(
				(a) => a.region === "piemonte" || a.region === "toscana",
			).flatMap((a) => a.producers.map((p) => p.name)),
		);
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			if (!info.awards?.some(isTreBicchieri)) continue;
			expect(italyProducers.has(name), name).toBe(true);
		}
	});

	// トレ・ビッキエーリは生産者ではなく個別のワインへの賞。対象ワインの無い
	// エントリは登録ミスで、ダイアログに何を獲ったのか出ない。
	it("トレ・ビッキエーリは受賞ワイン名を持つ", () => {
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			for (const award of info.awards ?? []) {
				if (!isTreBicchieri(award)) continue;
				expect(award.wine?.length ?? 0, name).toBeGreaterThan(0);
			}
		}
	});

	// 受賞リスト(ピエモンテ77件/トスカーナ93件)と収録生産者の積集合。取りこぼしや
	// 重複追加をここで検出する。件数を動かすときは出典を引き直すこと。
	it("トレ・ビッキエーリの地域別件数が調査結果と一致する", () => {
		const regionOf = new Map(
			AOPS.flatMap((a) => a.producers.map((p) => [p.name, a.region] as const)),
		);
		const byRegion = new Map<string, number>();
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			if (!info.awards?.some(isTreBicchieri)) continue;
			const region = regionOf.get(name) ?? "(不明)";
			byRegion.set(region, (byRegion.get(region) ?? 0) + 1);
		}
		expect(Object.fromEntries(byRegion)).toEqual({ piemonte: 30, toscana: 38 });
	});
});

describe("生産者名の表記ゆれ", () => {
	const producerNames = [
		...new Set(AOPS.flatMap((a) => a.producers.map((p) => p.name))),
	];

	/** アクセント・大小文字・空白の違いを潰した比較キー */
	const normalize = (name: string): string =>
		name
			.normalize("NFD")
			// NFD で分離した結合ダイアクリティカルマーク(U+0300〜U+036F)を落とす
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/\s+/g, "");

	// PRODUCER_INFO / PRODUCER_SEARCH_KEYWORDS は生産者名をキーに引くため、
	// アクセント違い・空白違いの表記ゆれがあると同じ生産者が別キーに分裂し、
	// 片方だけ解説も検索キーワードも引けない状態になる(#202)。
	it("アクセント・空白違いだけの生産者名が併存しない", () => {
		const byKey = new Map<string, string[]>();
		for (const name of producerNames) {
			const key = normalize(name);
			byKey.set(key, [...(byKey.get(key) ?? []), name]);
		}
		const collisions = [...byKey.values()].filter((names) => names.length > 1);
		expect(collisions).toEqual([]);
	});

	// 「Krug (Clos du Mesnil)」のような括弧書きは name ではなく note に置く。
	// name に混ぜると同じ生産者が別キーに分裂する。ボルドーのシャトー(winery)の
	// producers は所有者/運営体の説明であり辞書キーにならないため対象外。
	it("winery 以外の生産者名に括弧書きの別名が混ざらない", () => {
		const named = AOPS.filter((a) => a.kind !== "winery").flatMap((a) =>
			a.producers.map((p) => ({ aopId: a.id, name: p.name })),
		);
		const withParen = named.filter(({ name }) => /[(（]/.test(name));
		expect(withParen).toEqual([]);
	});
});

describe("ピエモンテ(イタリア)の整合性", () => {
	const piemonte = AOPS.filter((a) => a.region === "piemonte");

	it("件数スナップショット(DOCG18 / DOC11 / 計29)", () => {
		expect(piemonte.length).toBe(29);
		expect(piemonte.filter((a) => a.tags?.includes("docg")).length).toBe(18);
		expect(piemonte.filter((a) => a.tags?.includes("doc")).length).toBe(11);
	});

	it("各レコードは docg / doc のちょうど一方を持つ", () => {
		for (const aop of piemonte) {
			const tags = aop.tags ?? [];
			const n = Number(tags.includes("docg")) + Number(tags.includes("doc"));
			expect(n, aop.id).toBe(1);
		}
	});

	it("docg / doc / igt タグはイタリア(ピエモンテ / トスカーナ)以外に付かない", () => {
		const italianRegions = new Set(["piemonte", "toscana"]);
		for (const aop of AOPS.filter((a) => !italianRegions.has(a.region))) {
			const tags = aop.tags ?? [];
			expect(
				tags.includes("docg") || tags.includes("doc") || tags.includes("igt"),
				aop.id,
			).toBe(false);
		}
	});

	it("区分は regional / village のみ(畑・ワイナリーは無し)", () => {
		for (const aop of piemonte) {
			expect(["regional", "village"]).toContain(aop.kind);
		}
	});
});

describe("トスカーナ(イタリア)の整合性", () => {
	const toscana = AOPS.filter((a) => a.region === "toscana");

	it("件数スナップショット(DOCG11 / DOC17 / IGT1 / 計29)", () => {
		expect(toscana.length).toBe(29);
		expect(toscana.filter((a) => a.tags?.includes("docg")).length).toBe(11);
		expect(toscana.filter((a) => a.tags?.includes("doc")).length).toBe(17);
		expect(toscana.filter((a) => a.tags?.includes("igt")).length).toBe(1);
	});

	it("各レコードは docg / doc / igt のちょうど一つを持つ", () => {
		for (const aop of toscana) {
			const tags = aop.tags ?? [];
			const n =
				Number(tags.includes("docg")) +
				Number(tags.includes("doc")) +
				Number(tags.includes("igt"));
			expect(n, aop.id).toBe(1);
		}
	});

	it("区分は regional / village のみ(畑・ワイナリーは無し)", () => {
		for (const aop of toscana) {
			expect(["regional", "village"]).toContain(aop.kind);
		}
	});

	// スーパートスカーナは DOC(G) を名乗らないため #210 で掲載を見送った造り手が
	// いる(#212)。IGT エントリの顔ぶれを固定して、後から DOC(G) 側へ移されたり
	// 消えたりするのを防ぐ。件数だけのスナップショットは中身の取り違えを
	// 検出できない(#216 の教訓)。
	//
	// 出典の強さに差があることに注意:
	//  - Marchesi Antinori: 公式 antinori.it の銘柄ページが "Tignanello Toscana IGT"
	//    "Solaia Toscana IGT" と明記
	//  - Masseto: 公式 masseto.com のテクニカルシートが "Massetino ... Toscana IGT"
	//    と明記
	//  - Montevertine: **公式 montevertine.it は呼称を一切書いていない**。
	//    「1982年に Consorzio del Chianti Classico を脱退し、以後は単に Montevertine
	//    として」とだけ述べる。Toscana IGT はラベル・流通情報での確認にとどまるため、
	//    公式サイトを引いて「呼称の記載が無い」と判断して外さないこと。
	it("トスカーナIGTの造り手はスーパータスカンの造り手と一致する", () => {
		const igt = toscana.find((a) => a.tags?.includes("igt"));
		expect(igt?.id).toBe("toscana-igt");
		expect(igt?.producers.map((p) => p.name)).toEqual([
			"Montevertine",
			"Masseto",
			"Marchesi Antinori",
		]);
	});
});

/** AOPごとの生産者名(重複を除く) */
const producerNamesOf = (aops: readonly Aop[]): string[] => [
	...new Set(aops.flatMap((a) => a.producers.map((p) => p.name))),
];

/**
 * 「その地域の生産者は全員カタカナ検索語を持つ」を満たすと宣言した地域(#211)。
 * 未登録の生産者はラテン文字のまま楽天を検索することになり、ほぼヒットしない。
 * 地域の整備が終わったらここへ足す。**外すのは後退**なので理由を残すこと。
 */
const KEYWORD_COMPLETE_REGIONS = [
	"rhone",
	"beaujolais",
	"champagne",
	"alsace",
	"loire",
] as const;
/**
 * カタカナ+中黒の原則から外れる検索語。**この表に載せた分だけ**が例外で、
 * `Salon` は「サロン」単独だと家具・美容室が大量にヒットするためカテゴリ語を足している。
 */
const KEYWORD_EXCEPTIONS: Record<string, string> = {
	Salon: "サロン シャンパーニュ",
};

describe("検索キーワードを整備済みの地域(#211)", () => {
	it.each(KEYWORD_COMPLETE_REGIONS)(
		"%s: 全生産者がカタカナ表記を持つ",
		(id) => {
			const names = producerNamesOf(AOPS.filter((a) => a.region === id));
			expect(names.length).toBeGreaterThan(0);
			expect(
				names.filter((name) => PRODUCER_SEARCH_KEYWORDS[name] === undefined),
			).toEqual([]);
		},
	);

	it.each(KEYWORD_COMPLETE_REGIONS)(
		"%s: 検索キーワードはカタカナと中黒だけ",
		(id) => {
			for (const name of producerNamesOf(AOPS.filter((a) => a.region === id))) {
				const keyword = PRODUCER_SEARCH_KEYWORDS[name];
				if (KEYWORD_EXCEPTIONS[name]) {
					expect(keyword, name).toBe(KEYWORD_EXCEPTIONS[name]);
					continue;
				}
				expect(keyword, name).toMatch(/^[ァ-ヴー・]+$/);
			}
		},
	);
});

describe("ローヌの生産者(#225)", () => {
	const rhone = AOPS.filter((a) => a.region === "rhone");
	const producerNames = producerNamesOf;
	const allNames = producerNames(rhone);

	// 「シャトーヌフ・デュ・パプが3件しかない」が #225 の起点。件数だけでは中身の
	// 取り違えを検出できない(#216)ので顔ぶれを固定する。全件が公式の生産者組合
	// (Fédération des Syndicats de Producteurs de Châteauneuf-du-Pape)の名簿で確認済み。
	it("シャトーヌフ・デュ・パプの生産者は選定した18件と一致する", () => {
		const cdp = rhone.find((a) => a.id === "chateauneuf-du-pape");
		expect(cdp?.producers.map((p) => p.name)).toEqual([
			"Château de Beaucastel",
			"Château Rayas",
			"Domaine du Vieux Télégraphe",
			"Clos des Papes",
			"Domaine du Pégaü",
			"Château La Nerthe",
			"Domaine de la Janasse",
			"Domaine Henri Bonneau",
			"Le Vieux Donjon",
			"Domaine Charvin",
			"Domaine de Marcoux",
			"Domaine Roger Sabon",
			"Clos du Mont-Olivet",
			"Château de la Gardine",
			"Château Fortia",
			"Domaine de Beaurenard",
			"Clos Saint-Jean",
			"Château Mont-Redon",
		]);
	});

	// 北ローヌ(シラー単一品種の急斜面)と南ローヌ(グルナッシュ主体の広域)は
	// 学習上どちらも重要。片側だけ厚くならないことを固定する。
	it("北ローヌ・南ローヌのどちらかに偏っていない", () => {
		const nord = producerNames(
			rhone.filter((a) => a.subregionId === "rhone-septentrional"),
		).length;
		const sud = producerNames(
			rhone.filter((a) => a.subregionId === "rhone-meridional"),
		).length;
		expect(nord).toBe(43);
		expect(sud).toBe(68);
		// 少ない側が多い側の半分を下回らない(=どちらかが手薄になっていない)
		expect(Math.min(nord, sud) * 2).toBeGreaterThanOrEqual(Math.max(nord, sud));
	});

	// 北ローヌ・南ローヌの各クリュに「代表的な造り手が一通り」載っている状態を固定する。
	// 下限を割ってよいのは理由がある2つだけ。周辺地区(ディオワ等)は対象外。
	const MIN_PRODUCERS: Record<string, number> = {
		// AOC全域を単一の所有者が持つモノポールなので1件で正しい
		"chateau-grillet": 1,
		// 2023年にクリュへ昇格した新しいAOC。公式サイトが応答せず、
		// 一次情報で造り手を確認できたのが4件にとどまる
		laudun: 4,
	};

	it("北ローヌ・南ローヌのクリュは造り手を5件以上持つ", () => {
		const crus = rhone.filter(
			(a) =>
				a.kind === "village" &&
				(a.subregionId === "rhone-septentrional" ||
					a.subregionId === "rhone-meridional"),
		);
		for (const aop of crus) {
			const min = MIN_PRODUCERS[aop.id] ?? 5;
			expect(aop.producers.length, aop.id).toBeGreaterThanOrEqual(min);
		}
	});

	// #225 の調査で「載せてはいけない/旧称だった」と判明したもの。理由を残さないと
	// 「網羅されていない」と判断して後から足し戻されるため、名前で禁止する(#216 と同じ趣旨)。
	it("調査で除外・改称した名前が復活していない", () => {
		const removed = [
			// 2010年ヴィンテージ以降 AOC ラストーを名乗らず IGP Vaucluse で瓶詰めしている
			"Domaine Gourt de Mautens",
			// 2015年に Rhonéa 傘下となり、カーヴの名称は Balma Venitia
			"Vignerons de Beaumes de Venise",
			// 公式の生産者名簿・組合名簿で実在を確認できなかった
			"Cave de Grignan",
			"Domaine Fauchier-Marchal",
			"Domaine des Vins de Clairette",
			"Domaine de l'Amarine",
			// 2009年の4カーヴ合併で Les Vignerons Créateurs になった
			"Cave de Bellegarde",
			// 同一生産者の表記ゆれ。Cave de Die Jaillance / Caves Carod に統一
			"Cave Jaillance",
			"Cave Carod",
		];
		expect(allNames.filter((name) => removed.includes(name))).toEqual([]);
	});

	// ローヌには公的格付けが無く、年次ガイドのリストは転記しない方針。
	// 受賞を足すときは授与元・年・出典URLが取れることを確認してから入れる(#225)。
	it("ローヌの生産者は受賞を持たない", () => {
		for (const name of allNames) {
			expect(PRODUCER_INFO[name]?.awards, name).toBeUndefined();
		}
	});
});

describe("ボージョレの生産者(#228)", () => {
	const beaujolais = AOPS.filter((a) => a.region === "beaujolais");
	const allNames = producerNamesOf(beaujolais);

	/** ボージョレの10クリュ。広域AOCの beaujolais は含まない */
	const CRU_IDS = [
		"brouilly",
		"chenas",
		"chiroubles",
		"cote-de-brouilly",
		"fleurie",
		"julienas",
		"morgon",
		"moulin-a-vent",
		"regnie",
		"saint-amour",
	];

	// 着手前は全11AOPが一律2件で、10クリュそれぞれの代表的な造り手を
	// 反映できていなかった(#228)。
	it("10クリュすべてが5件以上の造り手を持つ", () => {
		for (const id of CRU_IDS) {
			const cru = beaujolais.find((a) => a.id === id);
			expect(cru, id).toBeDefined();
			expect(cru?.producers.length, id).toBeGreaterThanOrEqual(5);
		}
	});

	it("クリュの一覧はボージョレの10クリュと一致する", () => {
		const villages = beaujolais
			.filter((a) => a.kind === "village")
			.map((a) => a.id)
			.sort();
		expect(villages).toEqual([...CRU_IDS].sort());
	});

	// 自然派の系譜(いわゆる「ギャング・オブ・フォー」)はボージョレの学習文脈で
	// 外せない。モルゴン/レニエに散らばるので、顔ぶれとして固定する。
	it("ギャング・オブ・フォーの4人がクリュの生産者に載っている", () => {
		for (const name of [
			"Marcel Lapierre",
			"Jean Foillard",
			"Jean-Paul Thévenet",
			"Guy Breton",
		]) {
			expect(allNames, name).toContain(name);
		}
	});

	// #228 の調査で「公式名簿の表記と違う」と分かったもの。
	it("調査で改称した名前が復活していない", () => {
		const removed = [
			// クリュ・シェナのODG名簿での表記は「Cave du Château de Chénas」(協同組合)
			"Château de Chénas",
		];
		expect(allNames.filter((name) => removed.includes(name))).toEqual([]);
	});

	// ローヌ(#225)と同じく公的格付けが無く、年次ガイドのリストは転記しない方針。
	it("ボージョレの生産者は受賞を持たない", () => {
		for (const name of allNames) {
			expect(PRODUCER_INFO[name]?.awards, name).toBeUndefined();
		}
	});
});

describe("シャンパーニュの生産者(#224)", () => {
	const champagne = AOPS.filter((a) => a.region === "champagne");
	const producersOf = (aopId: string): string[] =>
		champagne.find((a) => a.id === aopId)?.producers.map((p) => p.name) ?? [];
	const allNames = [
		...new Set(champagne.flatMap((a) => a.producers.map((p) => p.name))),
	];

	// 件数だけでは中身の取り違えを検出できない(#216)ので、代表的な格付け村は
	// 顔ぶれを固定する。全件、村に本拠を置くことを公的企業登記(Annuaire des
	// Entreprises)で、大手メゾンの畑所有を UMC の村ページで確認済み。
	it("主要なグラン・クリュ村の生産者は選定した顔ぶれと一致する", () => {
		expect(producersOf("ambonnay")).toEqual([
			"Egly-Ouriet",
			"Eric Rodez",
			"Marie-Noëlle Ledru",
			"Paul Déthune",
			"Krug",
		]);
		expect(producersOf("avize")).toEqual([
			"Jacques Selosse",
			"Agrapart & Fils",
			"De Sousa",
			"Franck Bonville",
			"Varnier-Fannière",
		]);
		expect(producersOf("ay")).toEqual([
			"Bollinger",
			"Deutz",
			"Ayala",
			"Henri Giraud",
			"Gatinois",
			"Henri Goutorbe",
			"Lallier",
		]);
		expect(producersOf("bouzy")).toEqual([
			"Paul Bara",
			"Pierre Paillard",
			"Barnaut",
			"Benoît Lahaye",
			"André Clouet",
			"Brice",
		]);
		expect(producersOf("le-mesnil-sur-oger")).toEqual([
			"Salon",
			"Delamotte",
			"Krug",
			"Pierre Péters",
			"Robert Moncuit",
			"Pertois-Moriset",
			"Guy Charlemagne",
			"Launois Père & Fils",
		]);
		expect(producersOf("verzenay")).toEqual([
			"G.H. Mumm",
			"Michel Arnould",
			"Hugues Godmé",
			"Pehu-Simonet",
			"Jacques Rousseaux",
		]);
	});

	// Club Trésors de Champagne(Special Club)の公開会員名簿(2026-07 時点の25社)は
	// #224 の選定の一次情報。会員のうち収録済みの格付け村に本拠を置く16社が、
	// その村に載っていることを固定する(名簿は入れ替わるため、外すときは版を確認する)。
	// 残る9社は格付け村ではない村(Montigny-sous-Châtillon / Étoges / Festigny /
	// Férebrianges / Villevenard / Chaumuzy / Moussy / Ville-sur-Arce / Les Riceys)に
	// 本拠を置くため、対応する AOP を持たない。
	it("Club Trésors 会員が本拠の村に載っている", () => {
		const members: [string, string][] = [
			["bouzy", "Paul Bara"],
			["chouilly", "Roland Champion"],
			["chouilly", "Vazart-Coquart"],
			["dizy", "Gaston Chiquet"],
			["sacy", "Dumenil"],
			["sacy", "Hervieux-Dumez"],
			["ludes", "Forget-Chemin"],
			["verzy", "Fresnet-Juillet"],
			["verzy", "Juillet-Lallement"],
			["cuis", "Pierre Gimonnet & Fils"],
			["ay", "Henri Goutorbe"],
			["mareuil-sur-ay", "Marc Hébrart"],
			["chigny-les-roses", "J. Lassalle"],
			["le-mesnil-sur-oger", "Pertois-Moriset"],
			["villers-marmery", "A. Margaine"],
			["cumieres", "Sanchez-Le Guédard"],
		];
		const missing = members.filter(
			([aopId, name]) => !producersOf(aopId).includes(name),
		);
		expect(missing).toEqual([]);
	});

	// #224 の起点は「生産者が1件しか無いAOPが多数ある」こと(62AOP中34村)。
	// 下の9村は、UMC の村ページに畑を所有するメゾンの記載が無いか1社しかなく、
	// かつ公的企業登記にも銘柄を名乗る造り手が見つからなかった村。
	// ここに村を足すときは、一次情報を引き直してから足すこと。
	const SINGLE_PRODUCER_AOPS = [
		// 既存の記載を据え置いた村(UMCにも登記にも裏付けが見つからなかった)
		"bezannes",
		"coligny",
		"cormontreuil",
		"etrechy",
		"montbre",
		"villers-aux-noeuds",
		// 一次情報で確認できた造り手/メゾンがちょうど1件だった村
		"coulommes-la-montagne",
		"trois-puits",
		"voipreux",
	];

	it("生産者が1件だけのAOPは明示した9村に限られる", () => {
		const singles = champagne
			.filter((a) => a.producers.length < 2)
			.map((a) => a.id)
			.sort();
		expect(singles).toEqual([...SINGLE_PRODUCER_AOPS].sort());
	});

	// #224 の調査で「その村の造り手ではない」と分かった組み合わせ。理由を残さないと
	// 「網羅されていない」と判断して後から足し戻される(#216 と同じ趣旨)。
	// 名前自体は正しい村・地方総称の側に残っているものが多いので、村ごとに禁止する。
	it("調査で外した生産者が村ごとに復活していない", () => {
		const removed: Record<string, string[]> = {
			// 1584年アイ創業だが2009年にエペルネへ本拠を移した。地方総称 champagne に移動
			ay: ["Gosset"],
			// ランス本拠。UMCのシルリー村ページに畑所有の記載がない
			// (17〜18世紀の「シルリーのワイン」は造り手の所在を示すものではない)
			sillery: ["Ruinart"],
			// ヴェルテュ本拠。vertus 側に載せる
			cramant: ["Larmandier-Bernier"],
			// 以下は UMC の村ページが挙げるメゾンと食い違っていたもの
			"beaumont-sur-vesle": ["Moët & Chandon", "Veuve Clicquot"],
			"billy-le-grand": ["Veuve Clicquot"],
			"bergeres-les-vertus": ["Veuve Clicquot"],
			"pargny-les-reims": ["G.H. Mumm"],
			sacy: ["Pommery"],
			taissy: ["Taittinger"],
			vaudemange: ["Veuve Clicquot"],
			"ville-dommange": ["Pommery"],
			"villers-allerand": ["G.H. Mumm"],
			"les-mesneux": ["Pommery"],
			"trois-puits": ["Pommery"],
			voipreux: ["Nicolas Feuillatte"],
			"villeneuve-renneville-chevigny": ["Nicolas Feuillatte"],
			// UMCの村ページに記載が無く、村に本拠を置く造り手へ差し替えた
			sermiers: ["G.H. Mumm"],
			"coulommes-la-montagne": ["G.H. Mumm"],
			"avenay-val-d-or": ["Moët & Chandon"],
			bisseuil: ["Moët & Chandon"],
		};
		const revived = Object.entries(removed).flatMap(([aopId, names]) =>
			names.filter((name) => producersOf(aopId).includes(name)),
		);
		expect(revived).toEqual([]);
	});

	// シャンパーニュには生産者の公的格付けが無く(格付けされるのは村)、
	// Club Trésors の会員名簿も加入年を持たないため awards には載せない。
	// 理由は producer-info.ts のコメントが単一情報源(#224)。
	it("シャンパーニュの生産者は受賞を持たない", () => {
		for (const name of allNames) {
			expect(PRODUCER_INFO[name]?.awards, name).toBeUndefined();
		}
	});

	it("件数スナップショット(62AOP / 生産者ユニーク145件 / 延べ189件)", () => {
		expect(champagne.length).toBe(62);
		expect(allNames.length).toBe(145);
		expect(champagne.reduce((n, a) => n + a.producers.length, 0)).toBe(189);
	});
});

describe("アルザスの生産者(#227)", () => {
	const alsace = AOPS.filter((a) => a.region === "alsace");
	const producersOf = (id: string): string[] =>
		alsace.find((a) => a.id === id)?.producers.map((p) => p.name) ?? [];
	const allNames = [
		...new Set(alsace.flatMap((a) => a.producers.map((p) => p.name))),
	];

	// アルザスには村名AOCが無く、51件のグラン・クリュ(畑)が地方名AOCの直下に並ぶ。
	// 「村の代表生産者」ではなく「その畑を実際に手がける造り手」を置く構造を固定する。
	it("51件のグラン・クリュ + 地方名2件で構成される", () => {
		expect(alsace.length).toBe(53);
		expect(alsace.filter((a) => a.kind === "vineyard").length).toBe(51);
		expect(alsace.filter((a) => a.kind === "regional").length).toBe(2);
	});

	// 生産者が1件だけのグラン・クリュを無くすのが #227 の主目的。
	it("生産者が1件だけのグラン・クリュが無い", () => {
		const thin = alsace
			.filter((a) => a.producers.length < 2)
			.map((a) => `${a.id}(${a.producers.length})`);
		expect(thin).toEqual([]);
	});

	// 件数だけでは中身の取り違えを検出できない(#216)ため、主要グラン・クリュは
	// 顔ぶれを固定する。全件、各生産者の公式サイトでその畑のワインを確認済み。
	it("シュロスベルグの造り手は選定した6件と一致する", () => {
		expect(producersOf("schlossberg")).toEqual([
			"Domaine Weinbach",
			"Paul Blanck",
			"Albert Mann",
			"Bott-Geyl",
			"Jean-Marc Bernhard",
			"Jean Becker",
		]);
	});

	it("ランゲンの造り手は選定した3件と一致する", () => {
		expect(producersOf("rangen")).toEqual([
			"Domaine Zind-Humbrecht",
			"Domaine Schoffit",
			"Wolfberger",
		]);
	});

	it("ブラントの造り手は選定した6件と一致する", () => {
		expect(producersOf("brand")).toEqual([
			"Domaine Zind-Humbrecht",
			"Josmeyer",
			"Albert Boxler",
			"Charles Baur",
			"Cave de Turckheim",
			"Cave Jean Geiler",
		]);
	});

	it("ヘングストの造り手は選定した6件と一致する", () => {
		expect(producersOf("hengst")).toEqual([
			"Domaine Zind-Humbrecht",
			"Josmeyer",
			"Albert Mann",
			"Barmès-Buecher",
			"Wunsch & Mann",
			"Cave Jean Geiler",
		]);
	});

	it("シェーネンブールの造り手は選定した8件と一致する", () => {
		expect(producersOf("schoenenbourg")).toEqual([
			"Dopff au Moulin",
			"Marc Tempé",
			"Marcel Deiss",
			"Hugel",
			"Bott-Geyl",
			"Meyer-Fonné",
			"Mittnacht Frères",
			"Cave de Ribeauvillé",
		]);
	});

	it("アルテンベルグ・ド・ベルグハイムの造り手は選定した5件と一致する", () => {
		expect(producersOf("altenberg-de-bergheim")).toEqual([
			"Marcel Deiss",
			"Gustave Lorentz",
			"Sylvie Spielmann",
			"Jean Sipp",
			"Cave de Ribeauvillé",
		]);
	});

	// ゲブヴィレールの4グラン・クリュは Domaines Schlumberger が大半を所有する
	// (キッテルレは26haのうち20ha)。2件しか置けないのは意図的で、手薄なのではない。
	it("ゲブヴィレールの4グラン・クリュは2大生産者で構成される", () => {
		for (const id of ["kitterle", "kessler", "saering"]) {
			expect(producersOf(id).sort(), id).toEqual([
				"Dirler-Cadé",
				"Domaines Schlumberger",
			]);
		}
		expect(producersOf("spiegel")).toEqual([
			"Dirler-Cadé",
			"Domaines Schlumberger",
			"Cave du Vieil Armand",
		]);
	});

	// #227 の調査で「同じ造り手の別表記」「公式の畑リストに無い」と判明したもの。
	// 理由を残さないと後から足し戻されるため名前で禁止する(#216 と同じ趣旨)。
	it("重複・旧称の生産者名が復活していない", () => {
		const removed = [
			// "Domaine Zind-Humbrecht" と同一。公式サイトの名乗りは Domaine 付き
			"Zind-Humbrecht",
			// 2009年に Domaine Rieflé が Seppi Landmann を取得し、
			// 現在は1つの Domaine Rieflé-Landmann(2ブランドを併記)
			"Domaine Rieflé",
			"Seppi Landmann",
			// 協同組合の商号・ラベル表記は Cave Jean Geiler(法人名はカーヴ・ヴィニコル・ダンジェルスハイム)
			"Cave d'Ingersheim",
		];
		expect(allNames.filter((name) => removed.includes(name))).toEqual([]);
	});

	it("公式の畑リストに無い組み合わせが復活していない", () => {
		// Jean-Marc Bernhard の公式グラン・クリュはフロリモン/ケフェルコップフ/マンブール/
		// フュルステンチューム/シュロスベルグ/ヴィネック・シュロスベルグ。ゾンマーベルグは無い
		expect(producersOf("sommerberg")).not.toContain("Jean-Marc Bernhard");
		// Bott-Geyl の公式グラン・クリュにマルクランは無い
		expect(producersOf("marckrain")).not.toContain("Bott-Geyl");
	});

	// アルザスに生産者の公的格付けは無く、年次ガイドの掲載リストは転記しない方針。
	// 受賞を足すときは授与元・受賞名・年・出典URLが揃うことを確認してから入れる。
	it("アルザスの生産者は受賞を持たない", () => {
		for (const name of allNames) {
			expect(PRODUCER_INFO[name]?.awards, name).toBeUndefined();
		}
	});
});

describe("ロワールの生産者(#226)", () => {
	const loire = AOPS.filter((a) => a.region === "loire");
	const producersOf = (id: string): string[] =>
		loire.find((a) => a.id === id)?.producers.map((p) => p.name) ?? [];
	const allNames = producerNamesOf(loire);
	const namesIn = (subregionId: string): string[] =>
		producerNamesOf(loire.filter((a) => a.subregionId === subregionId));

	// #226 の起点は「AOP 50件に対して生産者55件(1AOPあたり約1件)」。件数だけでは
	// 中身の取り違えを検出できない(#216)ので、主要AOPは顔ぶれを固定する。
	// 出典は Vins du Centre-Loire (BIVC) 公式の生産者名簿。
	it("サンセールの生産者は選定した9件と一致する", () => {
		expect(producersOf("sancerre")).toEqual([
			"Domaine Vacheron",
			"Henri Bourgeois",
			"Alphonse Mellot",
			"Domaine François Cotat",
			"Domaine Pascal Cotat",
			"Domaine Edmond Vatan",
			"Domaine Lucien Crochet",
			"Domaine Vincent Pinard",
			"Domaine Claude Riffault",
		]);
	});

	// 出典: Syndicat AOC Savennières 公式サイトの vignerons 一覧
	it("サヴニエールの生産者は公式名簿から選んだ8件と一致する", () => {
		expect(producersOf("savennieres")).toEqual([
			"Domaine des Baumard",
			"Nicolas Joly",
			"Château d'Épiré",
			"Domaine du Closel",
			"Eric Morgat",
			"Damien Laureau",
			"Domaine FL",
			"Château Pierre-Bise",
		]);
	});

	// 出典: Syndicat des Vins de Saumur 公式サイトの appellation 別 vignerons 名簿
	it("ソーミュール・シャンピニーの生産者は選定した8件と一致する", () => {
		expect(producersOf("saumur-champigny")).toEqual([
			"Clos Rougeard",
			"Domaine Filliatreau",
			"Château du Hureau",
			"Domaine Arnaud Lambert",
			"Domaine des Roches Neuves",
			"Château de Villeneuve",
			"Château Yvonne",
			"Domaine de Nerleux",
		]);
	});

	// ロワール唯一のグラン・クリュ。`tags` を持たない(格付けバッジは winery 由来)ため、
	// 生産者の顔ぶれ自体が唯一の回帰点になる。
	it("カール・ド・ショームの生産者は選定した6件と一致する", () => {
		expect(producersOf("quarts-de-chaume")).toEqual([
			"Domaine des Baumard",
			"Château Pierre-Bise",
			"Domaine FL",
			"Domaine de la Bergerie",
			"Château de Plaisance",
			"Domaine des Forges",
		]);
	});

	// 出典: Fédération des Vins de Nantes 公式の annuaire du vignoble
	it("ミュスカデ・セーヴル・エ・メーヌの生産者は選定した9件と一致する", () => {
		expect(producersOf("muscadet-sevre-et-maine")).toEqual([
			"Domaine de la Pépière",
			"Domaine de l'Ecu",
			"Domaine Luneau-Papin",
			"Domaines Landron",
			"Domaine Michel Brégeon",
			"Gadais Père et Fils",
			"La Haute Févrie",
			"Bonnet-Huteau",
			"Domaine Bruno Cormerais",
		]);
	});

	// ロワールは4地区+地方名にまたがり品種も産地ごとに違う。どれか1地区だけ厚くすると
	// 学習上の偏りになるため、地区ごとのユニーク生産者数を固定する。
	it("4地区のいずれかに偏っていない", () => {
		const counts = {
			"pays-nantais": namesIn("pays-nantais").length,
			"anjou-saumur": namesIn("anjou-saumur").length,
			touraine: namesIn("touraine").length,
			"centre-loire": namesIn("centre-loire").length,
		};
		expect(counts).toEqual({
			"pays-nantais": 24,
			"anjou-saumur": 53,
			touraine: 56,
			"centre-loire": 40,
		});
		// 最も薄い地区が最も厚い地区の1/3を下回らない(=どこかが手薄になっていない)
		const values = Object.values(counts);
		expect(Math.min(...values) * 3).toBeGreaterThanOrEqual(Math.max(...values));
	});

	/**
	 * 生産者が3件未満でよいAOP。ここに載せた分だけが例外で、理由が無いものは
	 * 「まだ調べていない」と同義なので下限テストで落とす。
	 */
	const SMALL_AOPS: Record<string, number> = {
		// 生産者は全体で6軒しかない極小AOC。公式に確認できたのは Maison Rousseau だけ
		"touraine-noble-joue": 1,
		// 55haの極小AOC。ソーミュールの生産者組合は7appellation別名簿にこのAOCを持たず、
		// 公式サイトで名乗りを確認できたのが2件にとどまる
		"cabernet-de-saumur": 2,
		// AOC Orléans の生産者組合サイト(aoc-orleans.fr)は失効しており、
		// 公式に裏の取れる造り手が2件しか残っていない
		orleans: 2,
		"orleans-clery": 2,
	};

	it("生産者が1件だけのAOPが無い(例外は理由付きで明示する)", () => {
		for (const aop of loire) {
			const min = SMALL_AOPS[aop.id] ?? 3;
			expect(aop.producers.length, aop.id).toBeGreaterThanOrEqual(min);
		}
	});

	// #226 の調査で「実在しない/旧称だった/そのAOCを名乗っていない」と判明したもの。
	// 理由を残さないと「網羅されていない」と判断して後から足し戻される(#216 と同じ趣旨)。
	it("調査で除外・改称した名前が復活していない", () => {
		const removed = [
			// 2013年に会社更生、2014年に Ampelidae へ事業譲渡され法人は抹消済み
			"Cave du Haut-Poitou",
			// 実在するのは Tessa Laroche の「Domaine aux Moines」。この名のシャトーは無い
			"Château de la Roche aux Moines",
			// 2023年に Bollinger 傘下で "Langlois" へ改称(Château を外した)
			"Langlois-Château",
			// 公式サイト・生産者組合の表記は Maison Rousseau
			"Rousseau Frères",
			// 実在するのは Sébastien Vaillant の「Domaine Sébastien Vaillant」
			"Domaine du Vaillant",
			// BIVC 名簿の表記は Domaine de Reuilly / Vignobles Berthier / Domaine Pellé
			"Denis Jamain",
			"Domaine Berthier",
			"Henry Pellé",
			// 公式サイトの表記は Clos Saint-Fiacre / Domaine de Châtenoy(いずれも綴り違い)
			"Clos St-Fiacre",
			"Domaine de Chatenoy",
			// Fédération des Vins de Nantes 名簿の表記は Vignoble Guindon
			"Domaine Guindon",
		];
		expect(allNames.filter((name) => removed.includes(name))).toEqual([]);
	});

	// 名簿と突き合わせて「そのAOCを名乗っていない」と判明した配置。件数では検出できない。
	it("公式名簿と矛盾する配置が復活していない", () => {
		// Fédération des Vins de Nantes の名簿で Pépière は Gros-Plant を持たない
		expect(producersOf("gros-plant-du-pays-nantais")).not.toContain(
			"Domaine de la Pépière",
		);
		// Syndicat des Vins de Saumur の Coteaux de Saumur 名簿(52件)に含まれない
		expect(producersOf("coteaux-de-saumur")).not.toContain(
			"Domaine des Roches Neuves",
		);
		// 同 Saumur Puy-Notre-Dame 名簿(17件)に含まれない
		expect(producersOf("saumur-puy-notre-dame")).not.toContain(
			"Château de Villeneuve",
		);
		// BIVC 名簿の Alphonse Mellot はサンセール/プイィ・フュメ/コート・ド・ラ・シャリテのみ
		expect(producersOf("coteaux-du-giennois")).not.toContain("Alphonse Mellot");
	});

	// ロワールに生産者の公的格付けは無く、年次ガイドの掲載リストは転記しない方針。
	// 受賞を足すときは授与元・受賞名・年・出典URLが揃うことを確認してから入れる。
	it("ロワールの生産者は受賞を持たない", () => {
		for (const name of allNames) {
			expect(PRODUCER_INFO[name]?.awards, name).toBeUndefined();
		}
	});
});

describe("境界GeoJSON(<region>-boundaries.geojson)の整合性", () => {
	const enabledRegions = REGIONS.filter((r) => r.enabled);

	it.each(enabledRegions.map((r) => [r.id, r] as const))(
		"%s: 境界GeoJSONが存在し地方1つ+有効な地区で構成される",
		(_id, region) => {
			const boundariesPath = path.join(
				process.cwd(),
				"public",
				region.boundariesPath ?? "",
			);
			expect(fs.existsSync(boundariesPath), boundariesPath).toBe(true);

			const geojson = JSON.parse(fs.readFileSync(boundariesPath, "utf8")) as {
				features: {
					geometry: { type: string };
					properties: {
						level: string;
						regionId?: string;
						subregionId?: string;
						nameJa: string;
					};
				}[];
			};

			// 地方(level=region)はちょうど1つで、regionId が一致する
			const regionFeatures = geojson.features.filter(
				(f) => f.properties.level === "region",
			);
			expect(regionFeatures.length).toBe(1);
			expect(regionFeatures[0]?.properties.regionId).toBe(region.id);

			// 地区(level=subregion)は地域マスタの地理的地区(`*-regional` 以外)の
			// サブセット。収録AOPが無い地区(cote-de-sezanne 等)は欠けてよい
			const geographicIds = new Set(
				region.subregions
					.filter((s) => !s.id.endsWith("-regional"))
					.map((s) => s.id),
			);
			const subregionFeatures = geojson.features.filter(
				(f) => f.properties.level === "subregion",
			);
			const seen = new Set<string>();
			for (const f of subregionFeatures) {
				const id = f.properties.subregionId ?? "";
				expect(geographicIds.has(id), `${region.id}: ${id}`).toBe(true);
				expect(seen.has(id), `${region.id}: duplicate ${id}`).toBe(false);
				seen.add(id);
			}
			expect(geojson.features.length).toBe(1 + subregionFeatures.length);

			// 全フィーチャが面で nameJa を持つ
			for (const f of geojson.features) {
				expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
				expect(f.properties.nameJa.length).toBeGreaterThan(0);
			}
		},
	);
});

describe("GeoJSONとの整合性", () => {
	const enabledRegions = REGIONS.filter((r) => r.enabled);

	it.each(enabledRegions.map((r) => [r.id, r] as const))(
		"%s: GeoJSONが存在しメタデータと1:1で結合できる",
		(_id, region) => {
			const geojsonPath = path.join(
				process.cwd(),
				"public",
				region.geojsonPath ?? "",
			);
			expect(fs.existsSync(geojsonPath), geojsonPath).toBe(true);

			const geojson = JSON.parse(fs.readFileSync(geojsonPath, "utf8")) as {
				features: {
					bbox?: number[];
					geometry: { type: string; coordinates: unknown };
					properties: {
						idApp: number;
						aopId: string;
						kind: string;
						tags: string[];
						rank: number;
					};
				}[];
			};
			// ポリゴンを持たない詳細エントリ(クリマ・合成総称ノード)は GeoJSON に
			// 現れないので、1:1 の対象から除外する。
			const regionAops = AOPS.filter(
				(a) => a.region === region.id && a.idApp < POLYGONLESS_IDAPP_MIN,
			);
			expect(geojson.features.length).toBe(regionAops.length);

			const byIdApp = new Map(regionAops.map((a) => [a.idApp, a]));
			for (const f of geojson.features) {
				const meta = byIdApp.get(f.properties.idApp);
				expect(meta, `idApp ${f.properties.idApp}`).toBeDefined();
				expect(f.properties.aopId).toBe(meta?.id);
				expect(f.properties.kind).toBe(meta?.kind);
				expect(f.properties.tags).toEqual(meta?.tags ?? []);
				expect(f.properties.rank).toBe(
					{ regional: 0, village: 1, vineyard: 2, winery: 3 }[
						meta?.kind ?? "village"
					],
				);
				// シャトー(winery)は点、それ以外は面
				if (meta?.kind === "winery") {
					expect(f.geometry.type, meta.id).toBe("Point");
				} else {
					expect(["Polygon", "MultiPolygon"], meta?.id).toContain(
						f.geometry.type,
					);
				}
				// build:geodata が各フィーチャに事前計算した bbox([west,south,east,north])。
				// クライアント(AopMapView)がロード時の全座標走査を省くために使う(#33)。
				// 再生成で bbox が欠落・破損しないよう、座標から再計算して一致を検証する。
				expect(f.bbox, `${meta?.id} bbox`).toHaveLength(4);
				const [w, s, e, n] = f.bbox as [number, number, number, number];
				expect(
					[w, s, e, n].every((v) => Number.isFinite(v)),
					`${meta?.id} bbox finite`,
				).toBe(true);
				expect(computeGeometryBounds(f.geometry.coordinates), meta?.id).toEqual(
					[w, s, e, n],
				);
			}
		},
	);
});

// GeoJSONジオメトリの座標から bbox [west, south, east, north] を計算する(テスト検証用)
function computeGeometryBounds(
	coordinates: unknown,
): [number, number, number, number] {
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	const visit = (coords: unknown): void => {
		if (!Array.isArray(coords)) return;
		if (typeof coords[0] === "number") {
			const x = coords[0] as number;
			const y = coords[1] as number;
			if (x < west) west = x;
			if (x > east) east = x;
			if (y < south) south = y;
			if (y > north) north = y;
			return;
		}
		for (const c of coords) visit(c);
	};
	visit(coordinates);
	return [west, south, east, north];
}
