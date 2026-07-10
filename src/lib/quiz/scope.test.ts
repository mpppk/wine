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

	it("畑: 自身と親の村名AOC(複数村にまたがる場合は両方)を含む", () => {
		const ids = expandScopeAopIds("montrachet");
		expect(ids).toEqual(
			new Set(["montrachet", "puligny-montrachet", "chassagne-montrachet"]),
		);
	});

	it("地方AOP: 配下のシャトーがあれば含む", () => {
		const ids = expandScopeAopIds("haut-medoc");
		expect(ids).not.toBeNull();
		expect(ids).toContain("haut-medoc");
		expect(ids).toContain("chateau-la-lagune");
		expect(ids?.size).toBe(6);
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

	it("対象AOP自身が正解になる問題(AOPが答えの形式)は除外する", () => {
		// アンボネイ(champagne / montagne-de-reims の村)は配下を持たないので
		// スコープは自身のみ。対象=正解の location/odd-one-out/variety は全除外され、
		// 設問文に村名が出る colors:ambonnay だけが残る。
		const scoped = listScopedCandidates("champagne", ALL_TYPES, "ambonnay");
		expect(scoped).not.toBeNull();
		expect(scoped).toContain("colors:ambonnay");
		for (const key of scoped!) {
			const parsed = parseKey(key);
			expect(parsed).not.toBeNull();
			// AOPが答えの形式で aopId が対象AOP自身のキーは残っていないこと
			expect(
				parsed!.aopId === "ambonnay" &&
					AOP_ANSWER_QUIZ_TYPES.has(parsed!.quizType),
			).toBe(false);
		}
		// フィルタ前は対象=正解の AOP-answer キーが実在することを確認(回帰防止)
		const unfiltered = listCandidates("champagne", ALL_TYPES).filter((key) => {
			const parsed = parseKey(key);
			return (
				parsed !== null &&
				parsed.aopId === "ambonnay" &&
				AOP_ANSWER_QUIZ_TYPES.has(parsed.quizType)
			);
		});
		expect(unfiltered.length).toBeGreaterThan(0);
	});

	it("配下の畑(別AOP)が正解になる関連問題は残す", () => {
		// gevrey-chambertin 配下のクリュ(別AOP)を正解とする AOP-answer キーは残り、
		// 対象村自身(gevrey-chambertin)が正解の AOP-answer キーは消える。
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"gevrey-chambertin",
		);
		expect(scoped).not.toBeNull();
		// 配下クリュを正解とする AOP-answer キーが少なくとも1つ残る
		expect(
			scoped!.some((key) => {
				const parsed = parseKey(key);
				return (
					parsed !== null &&
					parsed.aopId === "chambertin" &&
					AOP_ANSWER_QUIZ_TYPES.has(parsed.quizType)
				);
			}),
		).toBe(true);
		// 対象村自身が正解の AOP-answer キーは1つも残らない
		for (const key of scoped!) {
			const parsed = parseKey(key);
			expect(
				parsed!.aopId === "gevrey-chambertin" &&
					AOP_ANSWER_QUIZ_TYPES.has(parsed!.quizType),
			).toBe(false);
		}
	});

	it("不明なslugや地域不一致は null", () => {
		expect(listScopedCandidates("bourgogne", ALL_TYPES, "no-such-aop")).toBe(
			null,
		);
		// morgon は beaujolais のAOP
		expect(listScopedCandidates("bourgogne", ALL_TYPES, "morgon")).toBeNull();
	});
});

describe("AOP_ANSWER_QUIZ_TYPES", () => {
	it("colors を含まず、AOPが正解になる3形式を含む", () => {
		expect(AOP_ANSWER_QUIZ_TYPES.has("colors")).toBe(false);
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
