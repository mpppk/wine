import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { candidateCountsByAopId, listCandidates } from "./generators";
import { parseKey } from "./keys";
import {
	countScopedQuestions,
	expandScopeAopIds,
	getQuizRedirectTargetId,
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

	it("固有の設問を持つ畑は自身のみで親の村名AOCを含まない(複数村にまたがる場合も同様)", () => {
		// 親方向(畑→村)は辿らない。複数の畑が村クイズを共有するのを避けるため。
		// モンラッシェは白のみで、村(ピュリニー/シャサーニュ=赤・白)と値が違うので
		// 固有の設問が残る = 借りる必要がない。
		expect(expandScopeAopIds("montrachet")).toEqual(new Set(["montrachet"]));
	});

	// 色・品種・地区が村と同一の独立AOC(シャンベルタン群・ヴォーヌのGC等)は設問が
	// 村側の1問に集約され、固有の設問が1つも残らない(#485: C案)。借用はしないため
	// スコープは自身のみ(0問)となり、ページでは村へのCTAを出す。
	it("集約されて固有の設問が0問になった畑は、借用せず自身のみ(#485)", () => {
		expect(expandScopeAopIds("chambertin")).toEqual(new Set(["chambertin"]));
		expect(expandScopeAopIds("romanee-conti")).toEqual(
			new Set(["romanee-conti"]),
		);
	});

	it("集約先自身も集約されている場合も、借用せず自身のみ(#485)", () => {
		// シャブリのクリマ → 傘AOC(シャブリ・グラン・クリュ) → シャブリ。
		// 傘AOC自身もシャブリと同一内容で集約されるが、借用はしない。
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
	it("傘AOC(畑): 自身と内包する個別クリマを含む(集約先の村は含まない #485)", () => {
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
		// 自身 + 7クリマ。集約先のシャブリは借用しない(#485: C案)
		expect(ids?.size).toBe(8);
		expect(ids).not.toContain("chablis");
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
		// 設問文の主語がAOPの各形式が残っている。配下9クリュは色・品種・地区が村と
		// 同一で村側の1問に集約されるため、主語は村になる。
		// aop-classification はブルゴーニュ(実在ラベル3種)では出題されないため含まれない
		// (自地域だけで4択を作れる地域=ボルドーのみが対象。別テストで確認)。
		expect(scoped).toContain("colors:gevrey-chambertin");
		expect(scoped).toContain("aop-variety:gevrey-chambertin");
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

	it("上位AOPと同一内容になる畑の設問は上位側の1問に集約され、傘自体は0問(#485)", () => {
		// シャブリ・グラン・クリュの7クリマは色・品種・地区が全て親と同じで、
		// クリマごとに出すと名前だけ違う同一内容のクイズが7回並ぶ。
		// クリマ主語のキーは列挙されない。C案では傘AOC自体も借用しないため0問となり、
		// ページではシャブリへのCTAを出す(集約ルール自体は変更しない)。
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"chablis-grand-cru",
		);
		expect(scoped).not.toBeNull();
		expect(scoped).toEqual([]);
		expect(scoped).not.toContain("colors:chablis-grand-cru");
	});

	// #373 が parentAopId しか見ておらず、法的な親AOCを持たない独立AOCのGCが
	// 素通りしていた。ジュヴレの9クリュは30問出て実質3種類の事実の反復だった。
	it("独立AOCのグラン・クリュも村側の1問に集約される(#436)", () => {
		const scoped = listScopedCandidates(
			"bourgogne",
			ALL_TYPES,
			"gevrey-chambertin",
		);
		expect(scoped).not.toBeNull();
		// 村自身の色・品種・地区の3問だけになる(9クリュぶんの反復が消える)
		expect([...scoped!].sort()).toEqual([
			"aop-subregion:gevrey-chambertin",
			"aop-variety:gevrey-chambertin",
			"colors:gevrey-chambertin",
		]);
	});

	it("集約された畑のスコープは0問で、村への誘導はリダイレクトで扱う(#485)", () => {
		// 固有の設問が0問になった畑は集約先の設問を借りない。スコープは自身のみで
		// 候補は0件になり、ページではクイズ導線の代わりに村へのCTAを出す。
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
		expect(chambertin).toEqual([]);
		expect(charmes).toEqual([]);
	});

	it("複数村にまたがる畑は、値が全村と一致する形式だけ集約される(#436)", () => {
		// ボンヌ・マールはシャンボール・ミュジニー(赤のみ)とモレ・サン・ドニ(赤・白)に
		// またがる。地区は両村ともコート・ド・ニュイなので集約するが、色・品種はモレと
		// 違うため残す(集約するとモレのスコープからこの事実が消える)。
		const scoped = listScopedCandidates("bourgogne", ALL_TYPES, "bonnes-mares");
		expect([...scoped!].sort()).toEqual([
			"aop-variety:bonnes-mares",
			"colors:bonnes-mares",
		]);
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

	it("集約された畑は借用しないため0問になり、クイズ導線は出ない(#485)", () => {
		// C案: 固有0問の畑は村の設問を借りず、詳細パネルでは村へのCTAを出す。
		expect(countScopedQuestions("bourgogne", "chablis-gc-les-clos")).toBe(0);
		expect(countScopedQuestions("bourgogne", "chambertin")).toBe(0);
		expect(countScopedQuestions("bourgogne", "romanee-conti")).toBe(0);
		// 村側は従来どおり3問
		expect(countScopedQuestions("bourgogne", "chablis")).toBeGreaterThan(0);
		expect(countScopedQuestions("bourgogne", "gevrey-chambertin")).toBe(3);
		expect(countScopedQuestions("bourgogne", "vosne-romanee")).toBe(3);
	});

	// リストの各行の進捗は AOP 単位の solved/total をスコープ集合で合算して出す
	// (map.$regionId.tsx)。パネルの問題数とズレると分母が食い違うため、
	// 借用を廃止してもこの不変条件が保たれることを固定する。
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

describe("getQuizRedirectTargetId (#485: C案)", () => {
	it("固有の設問があるAOP・不明なslugは null", () => {
		expect(getQuizRedirectTargetId("gevrey-chambertin")).toBeNull();
		expect(getQuizRedirectTargetId("vosne-romanee")).toBeNull();
		expect(getQuizRedirectTargetId("no-such-aop")).toBeNull();
	});

	it("ヴォーヌGCは村へ誘導する", () => {
		expect(getQuizRedirectTargetId("romanee-conti")).toBe("vosne-romanee");
		expect(getQuizRedirectTargetId("la-tache")).toBe("vosne-romanee");
		expect(getQuizRedirectTargetId("richebourg")).toBe("vosne-romanee");
	});

	it("シャンベルタン群はジュヴレへ誘導する", () => {
		expect(getQuizRedirectTargetId("chambertin")).toBe("gevrey-chambertin");
		expect(getQuizRedirectTargetId("charmes-chambertin")).toBe(
			"gevrey-chambertin",
		);
	});

	it("シャブリのクリマは中間の傘(0問)を飛ばしてシャブリへ誘導する", () => {
		expect(getQuizRedirectTargetId("chablis-gc-les-clos")).toBe("chablis");
		expect(getQuizRedirectTargetId("chablis-grand-cru")).toBe("chablis");
		expect(getQuizRedirectTargetId("chablis-1er-vaillons")).toBe("chablis");
	});

	it("誘導先が無い開かれた呼称は null(CTAも出さない)", () => {
		expect(getQuizRedirectTargetId("toscana-igt")).toBeNull();
		expect(getQuizRedirectTargetId("mosel")).toBeNull();
		expect(getQuizRedirectTargetId("niederoesterreich")).toBeNull();
	});

	it("固有0問のAOPは機械的に列挙でき、顔ぶれを固定する", () => {
		// ヴォーヌGCだけの特別扱いにしない。全該当AOPをSSOTで扱う。
		// bourgogne 43 + toscana 1 + deutschland 13 + oesterreich 6 = 63
		const zeros = AOPS.filter(
			(aop) => (candidateCountsByAopId(aop.region).get(aop.id) ?? 0) === 0,
		).map((aop) => aop.id);
		expect(zeros.length).toBe(63);
		// 代表例の顔ぶれ (数が合っていても銘柄が違うと誤った事実を教えるため固定)
		for (const id of [
			"romanee-conti",
			"la-tache",
			"richebourg",
			"chambertin",
			"chablis-gc-les-clos",
			"chablis-grand-cru",
		]) {
			expect(zeros).toContain(id);
		}
		// bourgogne の固有0問は全て誘導先(設問を持つ村)を持つ
		for (const target of AOPS.filter((a) => a.region === "bourgogne")) {
			if ((candidateCountsByAopId(target.region).get(target.id) ?? 0) === 0) {
				const redirectId = getQuizRedirectTargetId(target.id);
				expect(redirectId, target.id).not.toBeNull();
				if (redirectId === null) continue;
				expect(
					candidateCountsByAopId(target.region).get(redirectId) ?? 0,
					`${target.id} -> ${redirectId}`,
				).toBeGreaterThan(0);
			}
		}
	});
});
