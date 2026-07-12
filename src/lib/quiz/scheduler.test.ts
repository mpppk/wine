import { describe, expect, it } from "vitest";
import { mulberry32 } from "./rng";
import {
	filterUnsolved,
	pickQuestionKeys,
	type QuestionStatLike,
	scoreCandidate,
} from "./scheduler";

const NOW = 1_800_000_000_000; // 固定の現在時刻(epoch ms)
const DAY = 24 * 60 * 60 * 1000;

function stat(partial: Partial<QuestionStatLike>): QuestionStatLike {
	return {
		correctCount: 0,
		incorrectCount: 0,
		streak: 0,
		lastAnsweredAt: NOW - 30 * DAY,
		...partial,
	};
}

describe("scoreCandidate", () => {
	it("優先順位: 未出題 > 直近不正解 > 忘却した正解 > 直近正解", () => {
		const unseen = scoreCandidate(undefined, NOW);
		const recentlyWrong = scoreCandidate(
			stat({ incorrectCount: 2, streak: 0, lastAnsweredAt: NOW - 1 * DAY }),
			NOW,
		);
		const staleCorrect = scoreCandidate(
			stat({
				correctCount: 3,
				streak: 3,
				lastAnsweredAt: NOW - 30 * DAY,
			}),
			NOW,
		);
		const recentCorrect = scoreCandidate(
			stat({ correctCount: 3, streak: 3, lastAnsweredAt: NOW - 1 * DAY }),
			NOW,
		);
		expect(unseen).toBeGreaterThan(recentlyWrong);
		expect(recentlyWrong).toBeGreaterThan(staleCorrect);
		expect(staleCorrect).toBeGreaterThan(recentCorrect);
	});

	it("10分以内に解いた問題はクールダウンで大きく降格する", () => {
		const base = stat({ incorrectCount: 1, streak: 0 });
		const justAnswered = scoreCandidate(
			{ ...base, lastAnsweredAt: NOW - 60 * 1000 },
			NOW,
		);
		const old = scoreCandidate({ ...base, lastAnsweredAt: NOW - DAY }, NOW);
		expect(justAnswered).toBeLessThan(old * 0.2);
	});

	it("正答率が低いほどスコアが高い", () => {
		const wrong = scoreCandidate(
			stat({ correctCount: 1, incorrectCount: 3, lastAnsweredAt: NOW - DAY }),
			NOW,
		);
		const right = scoreCandidate(
			stat({
				correctCount: 3,
				incorrectCount: 1,
				streak: 2,
				lastAnsweredAt: NOW - DAY,
			}),
			NOW,
		);
		expect(wrong).toBeGreaterThan(right);
	});
});

describe("filterUnsolved", () => {
	const candidates = ["colors:aop-a", "colors:aop-b", "colors:aop-c"];

	it("実績行が無い(未出題)キーは未正解として残す", () => {
		expect(filterUnsolved(candidates, new Map())).toEqual(candidates);
	});

	it("一度でも正解した(correctCount>0)キーを除外する", () => {
		const statsByKey = new Map<string, QuestionStatLike>([
			// 正解済み: 除外される
			["colors:aop-a", stat({ correctCount: 1 })],
			// 不正解のみ: correctCount=0 なので残る
			["colors:aop-b", stat({ incorrectCount: 3, streak: 0 })],
		]);
		expect(filterUnsolved(candidates, statsByKey)).toEqual([
			"colors:aop-b",
			"colors:aop-c",
		]);
	});

	it("全問正解済みなら空配列(=残り0)", () => {
		const statsByKey = new Map<string, QuestionStatLike>(
			candidates.map((key) => [key, stat({ correctCount: 2 })]),
		);
		expect(filterUnsolved(candidates, statsByKey)).toEqual([]);
	});
});

describe("pickQuestionKeys", () => {
	// subject重複を検証するため、キーは "colors:{aopId}" 形式にする
	const candidates = Array.from({ length: 100 }, (_, i) => `colors:aop-${i}`);

	it("未出題キーが優先して選ばれる", () => {
		const statsByKey = new Map<string, QuestionStatLike>();
		// aop-10 以外はすべて直近正解済みにする
		for (const key of candidates) {
			if (key === "colors:aop-10") continue;
			statsByKey.set(
				key,
				stat({ correctCount: 5, streak: 5, lastAnsweredAt: NOW - DAY }),
			);
		}
		const picked = pickQuestionKeys({
			candidates,
			statsByKey,
			count: 5,
			now: NOW,
			rng: mulberry32(1),
		});
		expect(picked).toContain("colors:aop-10");
	});

	it("excludeKeys が除外される", () => {
		const exclude = candidates.slice(0, 90);
		const picked = pickQuestionKeys({
			candidates,
			statsByKey: new Map(),
			count: 10,
			excludeKeys: exclude,
			now: NOW,
			rng: mulberry32(2),
		});
		expect(picked).toHaveLength(10);
		for (const key of picked) {
			expect(exclude).not.toContain(key);
		}
	});

	it("同一バッチ内で同じsubjectを避ける(プールに余裕がある場合)", () => {
		// 同じsubjectのキーを大量に含む候補
		const sameSubject = Array.from(
			{ length: 50 },
			(_, i) => `odd-one-out:color:white:aop-${i % 5}`,
		);
		const picked = pickQuestionKeys({
			candidates: [...new Set(sameSubject)],
			statsByKey: new Map(),
			count: 5,
			now: NOW,
			rng: mulberry32(3),
		});
		const subjects = picked.map((k) => k.split(":").at(-1));
		expect(new Set(subjects).size).toBe(subjects.length);
	});

	it("subject候補が足りないときは重複を許容して count 件返す", () => {
		const fewSubjects = [
			"colors:aop-a",
			"odd-one-out:color:white:aop-a",
			"variety:gamay:aop-a",
		];
		const picked = pickQuestionKeys({
			candidates: fewSubjects,
			statsByKey: new Map(),
			count: 3,
			now: NOW,
			rng: mulberry32(4),
		});
		expect(picked).toHaveLength(3);
	});

	it("固定RNGで再現可能", () => {
		const run = () =>
			pickQuestionKeys({
				candidates,
				statsByKey: new Map(),
				count: 5,
				now: NOW,
				rng: mulberry32(9),
			});
		expect(run()).toEqual(run());
	});
});
