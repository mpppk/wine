import { describe, expect, it } from "vitest";
import {
	AI_WINE_LIST_LOCATE_MODEL,
	AI_WINE_LIST_LOCATE_WINES_PER_REQUEST,
} from "./config";
import {
	WINE_LIST_LOCATE_BOX_PROMPT,
	WINE_LIST_LOCATE_PRESENCE_PROMPT,
} from "./managed-prompts";
import {
	attachPhotoBoxes,
	buildLocateRequest,
	fillLocateInstruction,
	LOCATE_WINE_SLOT,
	type LocateRequestPlan,
	locateWineLabel,
	parseLocateAnswers,
	planLocateRequests,
} from "./wine-list-locate";

const BOX = { top: 0.1, bottom: 0.2, left: 0.3, right: 0.6 };

const INSTRUCTIONS = {
	box: WINE_LIST_LOCATE_BOX_PROMPT.template.replace(
		"{{wine}}",
		LOCATE_WINE_SLOT,
	),
	presence: WINE_LIST_LOCATE_PRESENCE_PROMPT.template.replace(
		"{{wine}}",
		LOCATE_WINE_SLOT,
	),
};

describe("locateWineLabel", () => {
	it("生産者・ワイン名・ヴィンテージを連ねる", () => {
		expect(
			locateWineLabel({
				name: "Chablis Les Clos",
				producer: "Vincent Dauvissat",
				vintage: 2019,
			}),
		).toBe("Vincent Dauvissat Chablis Les Clos 2019");
	});

	it("ワイン名が生産者名を含むときは重ねない(シャトー名=ワイン名)", () => {
		expect(
			locateWineLabel({
				name: "Château Margaux",
				producer: "Château Margaux",
			}),
		).toBe("Château Margaux");
	});

	it("呼称の日本語名で補われた名前は原語の呼称名にする(写真に印字されているのは原語)", () => {
		expect(
			locateWineLabel({ name: "シャブリ", aopId: "chablis", vintage: 2019 }),
		).toBe("Chablis 2019");
	});

	it("キュヴェ名だけの銘柄には原語の呼称を添える(重複はさせない)", () => {
		expect(
			locateWineLabel({
				name: "Les Clos",
				producer: "Dauvissat",
				aopId: "chablis",
			}),
		).toBe("Dauvissat Les Clos Chablis");
		expect(
			locateWineLabel({ name: "Chablis Les Clos", aopId: "chablis" }),
		).toBe("Chablis Les Clos");
	});

	it("指示文の引用符を壊さない", () => {
		expect(locateWineLabel({ name: 'Cuvée "X"' })).toBe("Cuvée 'X'");
	});

	it("名前も生産者も無い候補は問いを立てない", () => {
		expect(locateWineLabel({ vintage: 2020 })).toBeNull();
		expect(locateWineLabel({ name: "  " })).toBeNull();
	});
});

describe("planLocateRequests", () => {
	it("写真ごとに、写っている銘柄(photoIndexes と bottlePhotoIndex の和集合)をまとめる", () => {
		const plans = planLocateRequests(
			[
				{ suggestions: { name: "A" }, photoIndexes: [0, 1] },
				{ suggestions: { name: "B" }, photoIndexes: [1], bottlePhotoIndex: 2 },
				// 名前が無い候補・範囲外の番号は対象外
				{ suggestions: {}, photoIndexes: [0] },
				{ suggestions: { name: "C" }, photoIndexes: [9] },
			],
			3,
		);
		expect(plans).toEqual([
			{ photoIndex: 0, targets: [{ candidateIndex: 0, label: "A" }] },
			{
				photoIndex: 1,
				targets: [
					{ candidateIndex: 0, label: "A" },
					{ candidateIndex: 1, label: "B" },
				],
			},
			{ photoIndex: 2, targets: [{ candidateIndex: 1, label: "B" }] },
		]);
	});

	it("1枚に多数の銘柄が写る写真は上限ごとに分割する", () => {
		const count = AI_WINE_LIST_LOCATE_WINES_PER_REQUEST + 5;
		const plans = planLocateRequests(
			Array.from({ length: count }, (_, i) => ({
				suggestions: { name: `W${i}` },
				photoIndexes: [0],
			})),
			1,
		);
		expect(plans.map((p) => p.targets.length)).toEqual([
			AI_WINE_LIST_LOCATE_WINES_PER_REQUEST,
			5,
		]);
		expect(plans.every((p) => p.photoIndex === 0)).toBe(true);
	});
});

const PLAN: LocateRequestPlan = {
	photoIndex: 1,
	targets: [
		{ candidateIndex: 4, label: "Dauvissat Chablis 2019" },
		{ candidateIndex: 7, label: "Raveneau Chablis 2020" },
	],
};

describe("buildLocateRequest", () => {
	it("銘柄ごとに Box と Noul を並べ、指示文に銘柄名を差し込む", () => {
		const request = buildLocateRequest(
			PLAN,
			"data:image/jpeg;base64,AAAA",
			INSTRUCTIONS,
		);
		expect(request.model).toBe(AI_WINE_LIST_LOCATE_MODEL);
		expect(request.state[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,AAAA" },
		});
		expect(Object.keys(request.questions)).toEqual(["b0", "p0", "b1", "p1"]);
		expect(request.questions.b0?.type).toBe("box");
		expect(request.questions.p1?.type).toBe("noul");
		expect(request.questions.b0?.instructions).toContain(
			'"Dauvissat Chablis 2019"',
		);
		expect(request.questions.p1?.instructions).toContain(
			'"Raveneau Chablis 2020"',
		);
		// 差し込み位置の目印は残らない
		expect(JSON.stringify(request)).not.toContain(LOCATE_WINE_SLOT);
	});

	it("fillLocateInstruction は目印をすべて置き換える", () => {
		expect(
			fillLocateInstruction(`${LOCATE_WINE_SLOT}/${LOCATE_WINE_SLOT}`, "X"),
		).toBe("X/X");
	});
});

describe("parseLocateAnswers", () => {
	it("写っていて自信のある枠だけを採る", () => {
		const answers = parseLocateAnswers(PLAN, {
			b0: { type: "box", box: BOX, confidence: 0.9 },
			p0: { noul: 0.97 },
			// 写っていない(Box は対象が無くても4辺を返す)
			b1: { type: "box", box: BOX, confidence: 0.9 },
			p1: { noul: 0.1 },
		});
		expect(answers).toEqual([
			{ candidateIndex: 4, box: BOX, presence: 0.97, confidence: 0.9 },
			{ candidateIndex: 7, box: null, presence: 0.1, confidence: 0.9 },
		]);
	});

	it("confidence が低い枠は採らない", () => {
		const [answer] = parseLocateAnswers(PLAN, {
			b0: { box: BOX, confidence: 0.3 },
			p0: { noul: 1 },
		});
		expect(answer?.box).toBeNull();
	});

	it("欠けた答え・壊れた枠は枠なし(読めない答えを「写っている」に倒さない)", () => {
		const answers = parseLocateAnswers(PLAN, {
			b0: { box: BOX },
			p0: { noul: 1 },
			b1: { box: { top: "x" }, confidence: 1 },
			p1: { noul: 1 },
		});
		expect(answers.map((a) => a.box)).toEqual([null, null]);
		expect(parseLocateAnswers(PLAN, {}).map((a) => a.box)).toEqual([
			null,
			null,
		]);
	});
});

describe("attachPhotoBoxes", () => {
	it("写真ごとの枠を候補へ写真番号順に載せ、枠の無い候補はそのまま", () => {
		const candidates = [{ id: "a" }, { id: "b" }];
		const result = attachPhotoBoxes(candidates, [
			{
				photoIndex: 2,
				answers: [
					{ candidateIndex: 0, box: BOX, presence: 1, confidence: 1 },
					{ candidateIndex: 1, box: null, presence: 0, confidence: 1 },
				],
			},
			{
				photoIndex: 0,
				answers: [{ candidateIndex: 0, box: BOX, presence: 1, confidence: 1 }],
			},
		]);
		expect(result[0]).toEqual({
			id: "a",
			photoBoxes: [
				{ photoIndex: 0, box: BOX },
				{ photoIndex: 2, box: BOX },
			],
		});
		expect(result[1]).toEqual({ id: "b" });
	});
});
