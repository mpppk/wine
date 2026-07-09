import { describe, expect, it } from "vitest";
import { listCandidates } from "./generators";
import { parseKey } from "./keys";
import {
	countScopedQuestions,
	expandScopeAopIds,
	listScopedCandidates,
} from "./scope";
import { QUIZ_TYPE_IDS, type QuizType } from "./types";

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

	it("不明なslugや地域不一致は null", () => {
		expect(listScopedCandidates("bourgogne", ALL_TYPES, "no-such-aop")).toBe(
			null,
		);
		// morgon は beaujolais のAOP
		expect(listScopedCandidates("bourgogne", ALL_TYPES, "morgon")).toBeNull();
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
