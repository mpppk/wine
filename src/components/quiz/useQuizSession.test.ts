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

// Issue #151: 取得は成功するが、返る問題が全てセッション内で正解済みのまま
// (remaining > 0)でも、「問題を準備中…」の loading に恒久固着しないことを検証する。
describe("useQuizSession のセッション内正解済み枯渇ハンドリング", () => {
	beforeEach(() => {
		getNextQuestions.mockReset();
	});

	it("補充が尽きたら solvedKeysRef を除外に載せ、未正解を surface して出題を継続する", async () => {
		// 未ログインのサーバを模擬: セッション内の正解を知らないため、除外されて
		// いない trap を再抽選し続ける。全 trap が除外された時だけ本当の未正解 U を返す。
		// trap 数は queued + recent(RECENT_KEYS_LIMIT=20)で決して全除外できない数に
		// する。こうすると修正前(attempt1 で recent を捨て除外を減らす)は全 trap を
		// 除外できず未正解 U を surface できないまま loading に固着する。修正後は
		// attempt1 が solved(最大50)を除外に載せるので全 trap を除外でき U が出る。
		const TRAP = Array.from({ length: 40 }, (_, i) => `t${i}`);
		const U = "final-unsolved";
		getNextQuestions.mockImplementation(
			async (arg: { data: { excludeKeys?: string[] } }) => {
				const exclude = new Set(arg.data.excludeKeys ?? []);
				const availableTraps = TRAP.filter((k) => !exclude.has(k));
				const picked =
					availableTraps.length > 0
						? availableTraps.slice(0, 5).map(makeQuestion)
						: [makeQuestion(U)];
				// 未ログインではサーバの remaining は正解で減らない(全候補数を返す)
				return {
					questions: picked,
					remaining: TRAP.length + 1,
					total: TRAP.length + 1,
				};
			},
		);

		const { result } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], false),
		);

		// trap を順次正解していくと solvedKeysRef が直近窓を超えて溜まる。
		// 修正により最終的に未正解 U が surface される(loading 固着しない)。
		let reachedU = false;
		for (let i = 0; i < 80; i++) {
			await waitFor(() => expect(result.current.phase).toBe("answering"));
			if (result.current.current?.key === U) {
				reachedU = true;
				break;
			}
			act(() => result.current.answer("a"));
			await waitFor(() => expect(result.current.phase).toBe("feedback"));
			act(() => result.current.next());
		}

		expect(reachedU).toBe(true);
		expect(result.current.phase).toBe("answering");
		expect(result.current.current?.key).toBe(U);
	});

	it("solved 除外でも正解済みしか返らない場合は loading に固着せず error へ落ち、retry で復帰する", async () => {
		// 除外に関わらず正解済みキーだけを返し続けるサーバ(正解済みが除外上限50を
		// 超える等で除外しきれない稀ケースの模擬)。remaining > 0 のまま補充できない。
		getNextQuestions.mockImplementation(async () => ({
			questions: [makeQuestion("solved-1")],
			remaining: 2,
			total: 2,
		}));

		const { result } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], false),
		);

		// 初回の1問が出る
		await waitFor(() => expect(result.current.current?.key).toBe("solved-1"));
		// 正解して solvedKeysRef に積む → キュー枯渇後の補充は正解済みしか返らない
		act(() => result.current.answer("a"));
		await waitFor(() => expect(result.current.phase).toBe("feedback"));
		act(() => result.current.next());
		// 恒久 loading ではなく error(再試行可能)へ遷移する
		await waitFor(() => expect(result.current.phase).toBe("error"));

		// retry で未正解が取れれば出題へ復帰する
		getNextQuestions.mockImplementation(async () => ({
			questions: [makeQuestion("fresh-1")],
			remaining: 1,
			total: 2,
		}));
		act(() => result.current.retry());
		await waitFor(() => expect(result.current.phase).toBe("answering"));
		expect(result.current.current?.key).toBe("fresh-1");
	});
});
