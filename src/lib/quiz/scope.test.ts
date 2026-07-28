import { describe, expect, it } from "vitest";
import { listCandidates } from "./generators";
import { parseKey } from "./keys";
import {
	countScopedQuestions,
	expandScopeAopIds,
	listScopedCandidates,
} from "./scope";
import { AOP_ANSWER_QUIZ_TYPES, QUIZ_TYPE_IDS, type QuizType } from "./types";

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

	it("畑: 自身のみで親の村名AOCは含まない(複数村にまたがる場合も同様)", () => {
		// 親方向(畑→村)は辿らない。複数の畑が村クイズを共有するのを避けるため。
		expect(expandScopeAopIds("montrachet")).toEqual(new Set(["montrachet"]));
		expect(expandScopeAopIds("chambertin")).toEqual(new Set(["chambertin"]));
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
		expect(ids?.size).toBe(8);
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

	it("クリマ: 自身のみで親畑は含まない(畑が村を含めないのと同じ向き)", () => {
		expect(expandScopeAopIds("chablis-gc-les-clos")).toEqual(
			new Set(["chablis-gc-les-clos"]),
		);
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

	it("設問文の主語がAOPの形式(colors等)だけを残し、AOPが答えの形式は全除外する", () => {
		// 「その地域に関連するクイズ」= 問題文そのものがスコープ内AOPに関する設問。
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
			// 残っているのは answerIsAop=false の形式のみ
			expect(AOP_ANSWER_QUIZ_TYPES.has(parsed!.quizType), key).toBe(false);
		}
		// 設問文の主語がAOPの各形式が残っている(配下クリマ chambertin ぶんも含む)。
		// aop-classification はブルゴーニュ(実在ラベル3種)では出題されないため含まれない
		// (自地域だけで4択を作れる地域=ボルドーのみが対象。別テストで確認)。
		expect(scoped).toContain("colors:gevrey-chambertin");
		expect(scoped).toContain("aop-variety:chambertin");
		expect(scoped).toContain("aop-subregion:gevrey-chambertin");
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

	it("配下を持たない村は自身の主語形式のみ(AOPが答えの形式は残らない)", () => {
		// アンボネイ(champagne / montagne-de-reims の村)は配下を持たないのでスコープは自身のみ。
		const scoped = listScopedCandidates("champagne", ALL_TYPES, "ambonnay");
		expect(scoped).not.toBeNull();
		expect(scoped).toContain("colors:ambonnay");
		for (const key of scoped!) {
			const parsed = parseKey(key);
			expect(AOP_ANSWER_QUIZ_TYPES.has(parsed!.quizType), key).toBe(false);
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
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"chablis-grand-cru",
		);
		expect(scoped).not.toBeNull();
		// 修正前は傘AOC自身のキーしか無く、クリマの設問は1件も含まれなかった。
		expect(scoped).toContain("colors:chablis-gc-les-clos");
		const climatKeys = scoped!.filter((key) =>
			parseKey(key)?.aopId.startsWith("chablis-gc-"),
		);
		expect(climatKeys.length).toBeGreaterThan(0);
	});
});

describe("AOP_ANSWER_QUIZ_TYPES", () => {
	it("設問文の主語がAOPの形式は含まず、AOPが正解になる形式を含む", () => {
		// 主語がAOP(=関連クイズに出す形式)
		expect(AOP_ANSWER_QUIZ_TYPES.has("colors")).toBe(false);
		expect(AOP_ANSWER_QUIZ_TYPES.has("aop-variety")).toBe(false);
		expect(AOP_ANSWER_QUIZ_TYPES.has("aop-subregion")).toBe(false);
		expect(AOP_ANSWER_QUIZ_TYPES.has("aop-classification")).toBe(false);
		// AOPが4択の正解にすぎない(=関連クイズから除外する)形式
		expect(AOP_ANSWER_QUIZ_TYPES.has("location")).toBe(true);
		expect(AOP_ANSWER_QUIZ_TYPES.has("odd-one-out")).toBe(true);
		expect(AOP_ANSWER_QUIZ_TYPES.has("variety")).toBe(true);
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
});
