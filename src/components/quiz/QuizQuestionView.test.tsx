import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QuizQuestion } from "#/lib/quiz/types";
import { QuizQuestionView } from "./QuizQuestionView";

// 支援技術から見たクイズの回帰テスト(#239)。
// 見た目には現れない性質(読み上げ・フォーカス・見出し階層)なので、壊れても
// 画面を見ているだけでは気づけない。ここで固定する。

const QUESTION: QuizQuestion = {
	key: "aop-subregion:chambolle-musigny",
	quizType: "aop-subregion",
	regionId: "bourgogne",
	subjectAopId: "chambolle-musigny",
	prompt: "シャンボール・ミュジニーはどの地区?",
	options: [
		{ id: "o1", label: "コート・ド・ニュイ" },
		{ id: "o2", label: "コート・ド・ボーヌ" },
	],
	correctOptionId: "o1",
	selectionKind: "single",
	correctOptionIds: ["o1"],
	explanation: "コート・ド・ニュイの村です。",
};

afterEach(cleanup);

describe("QuizQuestionView", () => {
	it("設問は h1 ではなく h2(地図ページの h1 と重複させない)", () => {
		render(
			<QuizQuestionView
				question={QUESTION}
				phase="answering"
				selectedOptionId={undefined}
				onAnswer={() => {}}
			/>,
		);

		expect(
			screen.getByRole("heading", { level: 2, name: QUESTION.prompt }),
		).toBeDefined();
		expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
	});

	it("解答前からライブリージョンが存在する(後から挿入すると読み上げられない)", () => {
		const { container } = render(
			<QuizQuestionView
				question={QUESTION}
				phase="answering"
				selectedOptionId={undefined}
				onAnswer={() => {}}
			/>,
		);

		const live = container.querySelector('[role="status"]');
		expect(live).not.toBeNull();
		// 解答前は空。中身だけが後から変わることで読み上げが走る
		expect(live?.textContent).toBe("");
	});

	it("解答後は正誤と解説がライブリージョンの中に入る", () => {
		const { container } = render(
			<QuizQuestionView
				question={QUESTION}
				phase="feedback"
				selectedOptionId="o2"
				onAnswer={() => {}}
			/>,
		);

		const live = container.querySelector('[role="status"]');
		expect(live?.textContent).toContain("不正解");
		expect(live?.textContent).toContain(QUESTION.explanation);
	});

	it("解答後も選択肢は disabled にせず aria-disabled にする(フォーカスを失わせない)", () => {
		render(
			<QuizQuestionView
				question={QUESTION}
				phase="feedback"
				selectedOptionId="o1"
				onAnswer={() => {}}
			/>,
		);

		for (const option of QUESTION.options) {
			const button = screen.getByRole("button", {
				name: new RegExp(option.label),
			});
			// disabled にするとブラウザがフォーカスを body に落とし、キーボード利用者は
			// 毎問ページ先頭から辿り直しになる
			expect((button as HTMLButtonElement).disabled).toBe(false);
			expect(button.getAttribute("aria-disabled")).toBe("true");
		}
	});

	it("解答後にもう一度押しても再解答にならない", () => {
		const calls: string[] = [];
		render(
			<QuizQuestionView
				question={QUESTION}
				phase="feedback"
				selectedOptionId="o1"
				onAnswer={(id) => calls.push(id)}
			/>,
		);

		// pointer-events では防げないキーボード操作(Enter)相当の click を直接起こす
		screen.getByRole("button", { name: /コート・ド・ボーヌ/ }).click();

		expect(calls).toEqual([]);
	});

	it("解答前は選択肢を押すと解答できる", () => {
		const calls: string[] = [];
		render(
			<QuizQuestionView
				question={QUESTION}
				phase="answering"
				selectedOptionId={undefined}
				onAnswer={(id) => calls.push(id)}
			/>,
		);

		screen.getByRole("button", { name: /コート・ド・ニュイ/ }).click();

		expect(calls).toEqual(["o1"]);
	});
});

const MULTI_QUESTION: QuizQuestion = {
	key: "colors:gevrey-chambertin",
	quizType: "colors",
	regionId: "bourgogne",
	subjectAopId: "gevrey-chambertin",
	prompt: "ジュヴレ・シャンベルタンの色をすべて選んでください",
	options: [
		{ id: "red", label: "赤のみ" },
		{ id: "white", label: "白のみ" },
		{ id: "rose", label: "ロゼのみ" },
	],
	correctOptionId: "red",
	selectionKind: "multi",
	correctOptionIds: ["red"],
	explanation: "赤のみです。",
};

describe("QuizQuestionView の複数選択", () => {
	it("回答中はチェックボタンと無効な「回答する」が表示される", () => {
		render(
			<QuizQuestionView
				question={MULTI_QUESTION}
				phase="answering"
				selectedOptionId={undefined}
				selectedOptionIds={[]}
				onAnswer={() => {}}
				onToggleOption={() => {}}
				onSubmitMulti={() => {}}
			/>,
		);

		for (const option of MULTI_QUESTION.options) {
			const button = screen.getByRole("button", {
				name: new RegExp(option.label),
			});
			expect(button.getAttribute("aria-pressed")).toBe("false");
		}
		const submit = screen.getByRole("button", { name: /回答する/ });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
	});

	it("チェックすると件数付きで「回答する」が有効になり、押すと確定する", () => {
		const toggles: string[] = [];
		let submitted = 0;
		render(
			<QuizQuestionView
				question={MULTI_QUESTION}
				phase="answering"
				selectedOptionId={undefined}
				selectedOptionIds={["red"]}
				onAnswer={() => {}}
				onToggleOption={(id) => toggles.push(id)}
				onSubmitMulti={() => {
					submitted++;
				}}
			/>,
		);

		expect(
			screen
				.getByRole("button", { name: /赤のみ/ })
				.getAttribute("aria-pressed"),
		).toBe("true");
		const submit = screen.getByRole("button", { name: /回答する/ });
		expect((submit as HTMLButtonElement).disabled).toBe(false);
		expect(submit.textContent).toContain("1件選択中");
		submit.click();
		expect(submitted).toBe(1);

		screen.getByRole("button", { name: /白のみ/ }).click();
		expect(toggles).toEqual(["white"]);
	});

	it("完全一致で回答後は正解になり、選び漏れがあると不正解と選び漏れ表示になる", () => {
		const { container, rerender } = render(
			<QuizQuestionView
				question={MULTI_QUESTION}
				phase="feedback"
				selectedOptionId={undefined}
				selectedOptionIds={["red"]}
				onAnswer={() => {}}
			/>,
		);
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			"正解！",
		);

		rerender(
			<QuizQuestionView
				question={MULTI_QUESTION}
				phase="feedback"
				selectedOptionId={undefined}
				selectedOptionIds={[]}
				onAnswer={() => {}}
			/>,
		);
		const live = container.querySelector('[role="status"]');
		expect(live?.textContent).toContain("不正解");
		expect(screen.getByText("正解(選び漏れ)")).toBeDefined();
	});
});
