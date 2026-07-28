import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aopArraySchema } from "./aop-schema";
import rawAops from "./aops.json";
import { AOPS } from "./aops-data";
import {
	MICHELIN_GRAPES_URL,
	PRODUCER_INFO,
	type ProducerAward,
} from "./producer-info";
import { REGION_IDS, REGIONS } from "./regions";
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

	it("docg / doc タグはイタリア(ピエモンテ / トスカーナ)以外に付かない", () => {
		const italianRegions = new Set(["piemonte", "toscana"]);
		for (const aop of AOPS.filter((a) => !italianRegions.has(a.region))) {
			const tags = aop.tags ?? [];
			expect(tags.includes("docg") || tags.includes("doc"), aop.id).toBe(false);
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

	it("件数スナップショット(DOCG11 / DOC17 / 計28)", () => {
		expect(toscana.length).toBe(28);
		expect(toscana.filter((a) => a.tags?.includes("docg")).length).toBe(11);
		expect(toscana.filter((a) => a.tags?.includes("doc")).length).toBe(17);
	});

	it("各レコードは docg / doc のちょうど一方を持つ", () => {
		for (const aop of toscana) {
			const tags = aop.tags ?? [];
			const n = Number(tags.includes("docg")) + Number(tags.includes("doc"));
			expect(n, aop.id).toBe(1);
		}
	});

	it("区分は regional / village のみ(畑・ワイナリーは無し)", () => {
		for (const aop of toscana) {
			expect(["regional", "village"]).toContain(aop.kind);
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
