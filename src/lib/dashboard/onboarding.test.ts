import { describe, expect, it } from "vitest";
import { STARTER_GUIDE_GRADUATION_SEEN } from "./constants";
import { buildStarterSteps, shouldShowStarterGuide } from "./onboarding";

describe("buildStarterSteps", () => {
	it("地図→クイズ→セラーの順で3ステップを返す", () => {
		const steps = buildStarterSteps({ seen: 0, cellarTotalCount: 0 });
		expect(steps.map((s) => s.id)).toEqual(["map", "quiz", "cellar"]);
	});

	it("地図は完了を判定できないので常にnull", () => {
		for (const input of [
			{ seen: 0, cellarTotalCount: 0 },
			{ seen: 10, cellarTotalCount: 3 },
		]) {
			expect(buildStarterSteps(input)[0]).toEqual({ id: "map", done: null });
		}
	});

	it("クイズは1問でも解いていれば完了", () => {
		expect(buildStarterSteps({ seen: 0, cellarTotalCount: 0 })[1]).toEqual({
			id: "quiz",
			done: false,
		});
		expect(buildStarterSteps({ seen: 1, cellarTotalCount: 0 })[1]).toEqual({
			id: "quiz",
			done: true,
		});
	});

	// 飲んだ本数(tastedCount)ではなく登録総数を渡す規約なので、「気になる」だけの
	// 登録でも完了になる。呼び出し側(DashboardView)が totalCount を渡すことが前提。
	it("セラーは1本でも登録していれば(未飲でも)完了", () => {
		expect(buildStarterSteps({ seen: 0, cellarTotalCount: 0 })[2]).toEqual({
			id: "cellar",
			done: false,
		});
		expect(buildStarterSteps({ seen: 0, cellarTotalCount: 1 })[2]).toEqual({
			id: "cellar",
			done: true,
		});
	});
});

describe("shouldShowStarterGuide", () => {
	it("何もしていない新規ユーザには出す", () => {
		expect(shouldShowStarterGuide({ seen: 0, cellarTotalCount: 0 })).toBe(true);
	});

	it("判定可能なステップが一部だけ完了なら出し続ける", () => {
		expect(shouldShowStarterGuide({ seen: 5, cellarTotalCount: 0 })).toBe(true);
		expect(shouldShowStarterGuide({ seen: 0, cellarTotalCount: 2 })).toBe(true);
	});

	it("判定可能なステップが全て完了したら出さない", () => {
		expect(shouldShowStarterGuide({ seen: 1, cellarTotalCount: 1 })).toBe(
			false,
		);
	});

	it("卒業ラインまで解いていれば未完了のステップが残っていても出さない", () => {
		expect(
			shouldShowStarterGuide({
				seen: STARTER_GUIDE_GRADUATION_SEEN,
				cellarTotalCount: 0,
			}),
		).toBe(false);
		// 卒業ライン直前はまだ出す
		expect(
			shouldShowStarterGuide({
				seen: STARTER_GUIDE_GRADUATION_SEEN - 1,
				cellarTotalCount: 0,
			}),
		).toBe(true);
	});
});
