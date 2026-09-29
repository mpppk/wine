import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { candidateCountsByAopId, listCandidates } from "./generators";
import { parseKey } from "./keys";
import {
	countScopedQuestions,
	expandScopeAopIds,
	listScopedCandidates,
} from "./scope";
import {
	AOP_ANSWER_QUIZ_TYPES,
	OUT_OF_SCOPE_QUIZ_TYPES,
	QUIZ_TYPE_IDS,
	type QuizType,
} from "./types";

const ALL_TYPES: QuizType[] = [...QUIZ_TYPE_IDS];

describe("expandScopeAopIds", () => {
	it("村: 自身と配下の畑(グラン・クリュ)を含み、無関係の村を含まない", () => {
		const ids = expandScopeAopIds("gevrey-chambertin");
		expect(ids).not.toBeNull();
		expect(ids).toContain("gevrey-chambertin");
		// aops.json 上の gevrey-chambertin 配下は9クリュ
		for (const cru of [
			"chambertin",
			"chambertin-clos-de-beze",
			"chapelle-chambertin",
			"charmes-chambertin",
			"griotte-chambertin",
			"latricieres-chambertin",
			"mazis-chambertin",
			"mazoyeres-chambertin",
			"ruchottes-chambertin",
		]) {
			expect(ids).toContain(cru);
		}
		expect(ids?.size).toBe(10);
		expect(ids).not.toContain("morey-saint-denis");
	});

	it("固有の設問を持つ畑は自身のみで親の村名AOCを含まない(複数村にまたがる場合も同様)", () => {
		// 親方向(畑→村)は辿らない。複数の畑が村クイズを共有するのを避けるため。
		// モンラッシェは白のみで、村(ピュリニー/シャサーニュ=赤・白)と値が違うので
		// 固有の設問が残る = 借りる必要がない。
		expect(expandScopeAopIds("montrachet")).toEqual(new Set(["montrachet"]));
	});

	// 色・品種・地区が村と同一の独立AOC(シャンベルタン群・ヴォーヌのGC等)は設問が
	// 村側の1問に集約され、#485以前は固有の設問が1つも残らず集約先の設問を借りていた。
	// #485でグラン・クリュ形式を関連クイズに含めたため、各畑が固有の1問
	// (grand-cru-select:{畑})を持ち、借りる必要がなくなった。借用機構自体は
	// 固有の設問が0問のAOP(シャブリ・グラン・クリュのような傘AOC)のために残る。
	it("特級形式を持つ畑は自身のみで親の村名AOCを含まない(#485)", () => {
		expect(expandScopeAopIds("chambertin")).toEqual(new Set(["chambertin"]));
		expect(expandScopeAopIds("romanee-conti")).toEqual(
			new Set(["romanee-conti"]),
		);
	});

	it("固有の設問が0問の傘AOCは、設問を持つAOPまで辿る", () => {
		// シャブリ・グラン・クリュは色・品種・地区のいずれも固有の設問を持たず
		// (シャブリと同一内容で集約される)、特級形式の主語にもならないため0問のまま。
		// この場合だけ上位方向へ辿り、集約先のシャブリの設問を借りる。
		// なお個別クリマ(les-clos等)は #485 以降は固有の特級形式を持つため借りない。
		expect(expandScopeAopIds("chablis-grand-cru")).toEqual(
			new Set([
				"chablis-grand-cru",
				"chablis-gc-les-clos",
				"chablis-gc-vaudesir",
				"chablis-gc-valmur",
				"chablis-gc-grenouilles",
				"chablis-gc-blanchot",
				"chablis-gc-bougros",
				"chablis-gc-preuses",
				"chablis",
			]),
		);
		expect(expandScopeAopIds("chablis-gc-les-clos")).toEqual(
			new Set(["chablis-gc-les-clos"]),
		);
	});

	it("地方AOP: 配下のシャトーがあれば含む", () => {
		const ids = expandScopeAopIds("haut-medoc");
		expect(ids).not.toBeNull();
		expect(ids).toContain("haut-medoc");
		expect(ids).toContain("chateau-la-lagune");
		expect(ids?.size).toBe(6);
	});

	// Issue #243: 個別クリマは villageAopIds ではなく parentAopId で親畑にぶら下がる。
	// このエッジを辿らないと、傘AOC・村のどちらを選んでも配下クリマが1問も出ない
	// (地域全体クイズには出るので、スコープ指定の時だけ出ない非対称になる)。
	it("傘AOC(畑): 自身と内包する個別クリマを含む", () => {
		const ids = expandScopeAopIds("chablis-grand-cru");
		expect(ids).not.toBeNull();
		expect(ids).toContain("chablis-grand-cru");
		// aops.json 上のシャブリ・グラン・クリュは7クリマ
		for (const climat of [
			"chablis-gc-les-clos",
			"chablis-gc-vaudesir",
			"chablis-gc-valmur",
			"chablis-gc-grenouilles",
			"chablis-gc-blanchot",
			"chablis-gc-bougros",
			"chablis-gc-preuses",
		]) {
			expect(ids).toContain(climat);
		}
		// 自身 + 7クリマ + 集約先のシャブリ(傘AOC自身もシャブリと同一内容で集約される)
		expect(ids?.size).toBe(9);
		expect(ids).toContain("chablis");
	});

	it("村: 傘AOC経由の2ホップで配下クリマまで含む", () => {
		const ids = expandScopeAopIds("chablis");
		expect(ids).not.toBeNull();
		// 1ホップ(村→畑)
		expect(ids).toContain("chablis-grand-cru");
		expect(ids).toContain("chablis-premier-cru");
		// 2ホップ(畑→クリマ)
		expect(ids).toContain("chablis-gc-les-clos");
		// 自身 + 畑2 + グラン・クリュ7 + プルミエ・クリュ17
		expect(ids?.size).toBe(27);
	});

	it("複数村にまたがる傘AOC(コルトン)も配下クリマを含み、各村からも辿れる", () => {
		expect(expandScopeAopIds("corton")?.size).toBe(9);
		// コルトンは3村(aloxe-corton / ladoix / pernand-vergelesses)にまたがる。
		// どの村から選んでも傘経由で同じ8クリマが入る。
		for (const village of ["aloxe-corton", "ladoix", "pernand-vergelesses"]) {
			const ids = expandScopeAopIds(village);
			expect(ids).toContain("corton");
			expect(ids?.size).toBeGreaterThan(
				// 修正前は村自身 + villageAopIds の畑だけだった
				(expandScopeAopIds("corton")?.size ?? 0) - 8,
			);
		}
	});

	it("階層エッジを持たない村は自身のみ", () => {
		expect(expandScopeAopIds("morgon")).toEqual(new Set(["morgon"]));
	});

	it("不明なslugは null", () => {
		expect(expandScopeAopIds("no-such-aop")).toBeNull();
	});
});

describe("listScopedCandidates", () => {
	it("全キーの対象AOPがスコープ内で、地域候補の部分集合になる", () => {
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"gevrey-chambertin",
		);
		expect(scoped).not.toBeNull();
		expect(scoped!.length).toBeGreaterThan(0);
		const subjects = expandScopeAopIds("gevrey-chambertin");
		const regionKeys = new Set(listCandidates("bourgogne", ALL_TYPES));
		for (const key of scoped!) {
			const parsed = parseKey(key);
			expect(parsed).not.toBeNull();
			expect(subjects).toContain(parsed!.aopId);
			expect(regionKeys).toContain(key);
		}
		expect(scoped).toContain("colors:gevrey-chambertin");
	});

	it("設問文の主語がAOPの形式 + 特級形式だけを残し、たまたま正解になる形式は全除外する", () => {
		// 「その地域に関連するクイズ」= 問題文そのものがスコープ内AOPに関する設問 +
		// グラン・クリュ形式(正解AOP自身の特級性を問うため関連とみなす #485)。
		// 正解がたまたま近傍AOPになるだけの形式(odd-one-out/variety/location)は、
		// 対象自身でも配下の畑でも一律に除外する。
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"gevrey-chambertin",
		);
		expect(scoped).not.toBeNull();
		for (const key of scoped!) {
			const parsed = parseKey(key);
			expect(parsed).not.toBeNull();
			// 残っているのはスコープ内形式のみ
			expect(OUT_OF_SCOPE_QUIZ_TYPES.has(parsed!.quizType), key).toBe(false);
		}
		// 設問文の主語がAOPの各形式が残っている。配下9クリュは色・品種・地区が村と
		// 同一で村側の1問に集約されるため、主語は村になる。
		// aop-classification はブルゴーニュ(実在ラベル3種)では出題されないため含まれない
		// (自地域だけで4択を作れる地域=ボルドーのみが対象。別テストで確認)。
		expect(scoped).toContain("colors:gevrey-chambertin");
		expect(scoped).toContain("aop-variety:gevrey-chambertin");
		expect(scoped).toContain("aop-subregion:gevrey-chambertin");
		// 特級形式も残る(#485): 村自身の仲間外れ + 配下9クリュぶんの特級選択
		expect(scoped).toContain("grand-cru-odd:gevrey-chambertin");
		expect(scoped).toContain("grand-cru-select:chambertin");
		expect(scoped).not.toContain("aop-classification:chambertin");
		// フィルタ前は対象/配下が正解の AOP-answer キーが実在することを確認(回帰防止)
		const unfiltered = listCandidates("bourgogne", ALL_TYPES).filter((key) => {
			const parsed = parseKey(key);
			return (
				parsed !== null &&
				(parsed.aopId === "gevrey-chambertin" ||
					parsed.aopId === "chambertin") &&
				AOP_ANSWER_QUIZ_TYPES.has(parsed.quizType)
			);
		});
		expect(unfiltered.length).toBeGreaterThan(0);
	});

	it("ボルドー(実在ラベル4種以上)では格付けクイズがスコープに残る", () => {
		// 制度混同を避けるため格付けクイズはボルドーのみ出題する。haut-medoc 配下の
		// シャトー・ラ・ラギューヌ(第3級)が主語の aop-classification が残ることを確認。
		const scoped = listScopedCandidates("bordeaux", ALL_TYPES, "haut-medoc");
		expect(scoped).not.toBeNull();
		expect(scoped).toContain("aop-classification:chateau-la-lagune");
	});

	it("配下を持たない村は自身の主語形式のみ(たまたま正解になる形式は残らない)", () => {
		// アンボネイ(champagne / montagne-de-reims の村)は配下を持たないのでスコープは自身のみ。
		// グラン・クリュ形式はブルゴーニュのみの出題なのでここには現れない。
		const scoped = listScopedCandidates("champagne", ALL_TYPES, "ambonnay");
		expect(scoped).not.toBeNull();
		expect(scoped).toContain("colors:ambonnay");
		for (const key of scoped!) {
			const parsed = parseKey(key);
			expect(OUT_OF_SCOPE_QUIZ_TYPES.has(parsed!.quizType), key).toBe(false);
		}
	});

	it("不明なslugや地域不一致は null", () => {
		expect(listScopedCandidates("bourgogne", ALL_TYPES, "no-such-aop")).toBe(
			null,
		);
		// morgon は beaujolais のAOP
		expect(listScopedCandidates("bourgogne", ALL_TYPES, "morgon")).toBeNull();
	});
	it("傘AOCのスコープにクリマ主語の候補キーが入る(#243)", () => {
		// クリマ主語の候補が存在する傘AOCで、parentAopId エッジを辿ることを固定する。
		// コルトンのクリマは色・品種が親と異なるため固有の候補キーを持つ。
		const scoped = listScopedCandidates("bourgogne", ALL_TYPES, "corton");
		expect(scoped).not.toBeNull();
		// 修正前は傘AOC自身のキーしか無く、クリマの設問は1件も含まれなかった。
		expect(scoped).toContain("colors:corton-les-bressandes");
		const climatKeys = scoped!.filter((key) =>
			parseKey(key)?.aopId.startsWith("corton-"),
		);
		expect(climatKeys.length).toBeGreaterThan(0);
	});

	it("上位AOPと同一内容になる畑の主語形式は上位側の1問に集約される", () => {
		// シャブリ・グラン・クリュの7クリマは色・品種・地区が全て親と同じで、
		// クリマごとに出すと名前だけ違う同一内容のクイズが7回並ぶ。
		// クリマ主語の主語形式キーは列挙されず、集約先(シャブリ)の設問だけが残る。
		// ただし特級形式は各クリマ固有の1問として残る(#485)。
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"chablis-grand-cru",
		);
		expect(scoped).not.toBeNull();
		expect(scoped).toContain("colors:chablis");
		expect(
			scoped!.filter(
				(key) =>
					parseKey(key)?.aopId.startsWith("chablis-gc-") &&
					!key.startsWith("grand-cru-select:"),
			),
		).toEqual([]);
		expect(scoped).not.toContain("colors:chablis-grand-cru");
		// 各クリマの特級選択は固有の設問として残る
		expect(scoped).toContain("grand-cru-select:chablis-gc-les-clos");
	});

	// #373 が parentAopId しか見ておらず、法的な親AOCを持たない独立AOCのGCが
	// 素通りしていた。ジュヴレの9クリュは30問出て実質3種類の事実の反復だった。
	// #437で村側の3問に集約し、#485で各クリュ固有の特級形式1問を加えた。
	it("独立AOCのグラン・クリュも村側の1問に集約される(#436)。村スコープには各クリュの特級形式が入る(#485)", () => {
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"gevrey-chambertin",
		);
		expect(scoped).not.toBeNull();
		// 村自身の色・品種・地区3問 + 村の仲間外れ1問 + 9クリュぶんの特級選択9問
		expect([...scoped!].sort()).toEqual(
			[
				"aop-subregion:gevrey-chambertin",
				"aop-variety:gevrey-chambertin",
				"colors:gevrey-chambertin",
				"grand-cru-odd:gevrey-chambertin",
				"grand-cru-select:chambertin",
				"grand-cru-select:chambertin-clos-de-beze",
				"grand-cru-select:chapelle-chambertin",
				"grand-cru-select:charmes-chambertin",
				"grand-cru-select:griotte-chambertin",
				"grand-cru-select:latricieres-chambertin",
				"grand-cru-select:mazis-chambertin",
				"grand-cru-select:mazoyeres-chambertin",
				"grand-cru-select:ruchottes-chambertin",
			].sort(),
		);
	});

	it("特級形式を持つ畑のスコープは自身の特級形式のみで、兄弟間で共有されない(#485)", () => {
		// #436以前は固有の設問が0問で集約先の村の3問を借りていたため、
		// 同じ村の畑同士・村自身が全く同じ候補集合になっていた。
		// #485で各畑が固有の特級形式を持つため借用は起きず、候補は畑ごとに変わる。
		const chambertin = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"chambertin",
		);
		const charmes = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"charmes-chambertin",
		);
		expect([...chambertin!].sort()).toEqual(["grand-cru-select:chambertin"]);
		expect([...charmes!].sort()).toEqual([
			"grand-cru-select:charmes-chambertin",
		]);
	});

	it("ヴォーヌ=ロマネの各グラン・クリュは固有の特級形式を持ち、毎回同じ村の3問にはならない(#485)", () => {
		// 回帰テスト: 7つのGCは村と事実が完全一致するため主語形式が0問だった。
		// 各GCのスコープが村の3キーに潰れていると、どの畑を開いても同じ問題が出る。
		const village = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"vosne-romanee",
		);
		expect(village).not.toBeNull();
		// 村スコープは村の3問 + 村の仲間外れ + 8GCぶんの特級選択
		expect(village!.length).toBe(12);
		for (const gc of [
			"echezeaux",
			"grands-echezeaux",
			"la-grande-rue",
			"la-romanee",
			"la-tache",
			"richebourg",
			"romanee-conti",
			"romanee-saint-vivant",
		]) {
			const scoped = listScopedCandidates("bourgogne", ALL_TYPES, gc);
			expect(scoped, gc).not.toBeNull();
			// 各GCは自身の特級選択1問のみ。村のキー(colors:vosne-romanee等)は含まない
			expect([...scoped!].sort(), gc).toEqual([`grand-cru-select:${gc}`]);
		}
	});

	it("複数村にまたがる畑は、値が全村と一致する形式だけ集約される(#436)", () => {
		// ボンヌ・マールはシャンボール・ミュジニー(赤のみ)とモレ・サン・ドニ(赤・白)に
		// またがる。地区は両村ともコート・ド・ニュイなので集約するが、色・品種はモレと
		// 違うため残す(集約するとモレのスコープからこの事実が消える)。
		// 特級形式は畑固有の1問として残る(#485)。
		const scoped = listScopedCandidates("bourgogne", ALL_TYPES, "bonnes-mares");
		expect([...scoped!].sort()).toEqual(
			[
				"aop-variety:bonnes-mares",
				"colors:bonnes-mares",
				"grand-cru-select:bonnes-mares",
			].sort(),
		);
	});
});

describe("OUT_OF_SCOPE_QUIZ_TYPES", () => {
	it("主語形式と特級形式は含まず、たまたま正解になる形式のみ含む(#485)", () => {
		// スコープに残る(=関連クイズに出す)形式
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("colors")).toBe(false);
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("aop-variety")).toBe(false);
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("aop-subregion")).toBe(false);
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("aop-classification")).toBe(false);
		// 正解AOP自身の特級性を問うため関連とみなす形式
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("grand-cru-select")).toBe(false);
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("grand-cru-odd")).toBe(false);
		// たまたま正解が近傍AOPになるだけ(=関連クイズから除外する)形式
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("location")).toBe(true);
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("odd-one-out")).toBe(true);
		expect(OUT_OF_SCOPE_QUIZ_TYPES.has("variety")).toBe(true);
	});
});

describe("countScopedQuestions", () => {
	it("スコープ内に問題があれば正の数を返す", () => {
		expect(countScopedQuestions("bourgogne", "gevrey-chambertin")).toBe(
			listScopedCandidates("bourgogne", ALL_TYPES, "gevrey-chambertin")!.length,
		);
		expect(countScopedQuestions("beaujolais", "morgon")).toBeGreaterThan(0);
	});

	it("不明なslugは 0", () => {
		expect(countScopedQuestions("bourgogne", "no-such-aop")).toBe(0);
	});

	it("固有の設問を持たないAOPは0問にならない(借用機構 #436 / 特級形式 #485)", () => {
		// 固有の設問が0問の傘AOC(シャブリ・グラン・クリュ)は集約先の設問を借りる。
		// 借りる前は0問でクイズボタン自体が出なかった。
		expect(
			countScopedQuestions("bourgogne", "chablis-grand-cru"),
		).toBeGreaterThan(0);
		// ヴォーヌの各GCは #485 で固有の特級形式を持つため借用なしで1問になる。
		expect(countScopedQuestions("bourgogne", "chablis-gc-les-clos")).toBe(1);
		expect(countScopedQuestions("bourgogne", "chambertin")).toBe(1);
		expect(countScopedQuestions("bourgogne", "romanee-conti")).toBe(1);
	});

	// リストの各行の進捗は AOP 単位の solved/total をスコープ集合で合算して出す
	// (map.$regionId.tsx)。パネルの問題数とズレると分母が食い違うため、集約先の
	// 設問を借りる仕組みを入れてもこの不変条件が保たれることを固定する。
	it("スコープ集合の候補数合算が、パネルの問題数と全AOPで一致する", () => {
		for (const aop of AOPS) {
			const scope = expandScopeAopIds(aop.id);
			expect(scope, aop.id).not.toBeNull();
			const counts = candidateCountsByAopId(aop.region);
			let sum = 0;
			for (const id of scope!) sum += counts.get(id) ?? 0;
			expect(sum, aop.id).toBe(countScopedQuestions(aop.region, aop.id));
		}
	});
});
