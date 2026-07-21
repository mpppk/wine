import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizQuestion } from "#/lib/quiz/types";

// server function / router は Cloudflare 依存を引き込むためモックする。
const getNextQuestions = vi.fn();
vi.mock("#/server/quiz", () => ({
	getNextQuestions: (...args: unknown[]) => getNextQuestions(...args),
	recordAnswer: vi.fn(),
	revertAnswer: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn() }),
}));

const { useQuizSession } = await import("./useQuizSession");

function makeQuestion(key: string): QuizQuestion {
	return {
		key,
		quizType: "colors",
		regionId: "bourgogne",
		prompt: "?",
		options: [
			{ id: "a", label: "A", labelSub: "" },
			{ id: "b", label: "B", labelSub: "" },
			{ id: "c", label: "C", labelSub: "" },
			{ id: "d", label: "D", labelSub: "" },
		],
		correctOptionId: "a",
		explanation: "x",
		subjectAopId: "a",
	};
}

// Issue #26: 取得失敗時に「問題を準備中…」のまま固まらず error フェーズへ遷移し、
// retry で復帰できることを検証する。
describe("useQuizSession の取得失敗ハンドリング", () => {
	beforeEach(() => {
		getNextQuestions.mockReset();
	});

	it("初回取得が失敗すると loading のままではなく error になる", async () => {
		getNextQuestions.mockRejectedValueOnce(new Error("boom"));
		const { result } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], false),
		);
		await waitFor(() => expect(result.current.phase).toBe("error"));
	});

	it("retry で再取得し、成功すると出題フェーズへ復帰する", async () => {
		getNextQuestions.mockRejectedValueOnce(new Error("boom"));
		const { result } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], false),
		);
		await waitFor(() => expect(result.current.phase).toBe("error"));

		getNextQuestions.mockResolvedValueOnce({
			questions: [makeQuestion("colors:x:y")],
			remaining: 1,
			total: 1,
		});
		act(() => {
			result.current.retry();
		});
		await waitFor(() => expect(result.current.phase).toBe("answering"));
		expect(result.current.current?.key).toBe("colors:x:y");
	});

	// プリフェッチ中にキューが尽きてから失敗しても loading で固まらず error になる。
	// (捕捉時の live な queue で判定しないと再現する回帰。)
	it("プリフェッチ失敗×キュー枯渇でも loading に固まらず error になる", async () => {
		let rejectPrefetch: (e: unknown) => void = () => {};
		const prefetch = new Promise((_resolve, reject) => {
			rejectPrefetch = reject;
		});
		getNextQuestions
			// 初回: 2問(=PREFETCH_THRESHOLD)返すと即プリフェッチが走る
			.mockResolvedValueOnce({
				questions: [makeQuestion("k1"), makeQuestion("k2")],
				remaining: 5,
				total: 5,
			})
			// プリフェッチ: 未解決のまま保持し、キュー枯渇後に失敗させる
			.mockReturnValueOnce(prefetch);

		const { result } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], false),
		);
		await waitFor(() => expect(result.current.current?.key).toBe("k1"));

		// k1 → k2 と消化してキューを空にする(phase は loading になる)
		act(() => result.current.answer("a"));
		act(() => result.current.next());
		await waitFor(() => expect(result.current.current?.key).toBe("k2"));
		act(() => result.current.answer("a"));
		act(() => result.current.next());
		await waitFor(() => expect(result.current.phase).toBe("loading"));

		// 保持していたプリフェッチをここで失敗させる
		await act(async () => {
			rejectPrefetch(new Error("boom"));
			await Promise.resolve();
		});
		await waitFor(() => expect(result.current.phase).toBe("error"));
	});
});
