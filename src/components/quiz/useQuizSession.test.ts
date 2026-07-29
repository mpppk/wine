import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_MESSAGE } from "#/lib/errors";
import type { QuizQuestion, QuizType } from "#/lib/quiz/types";

// server function / router は Cloudflare 依存を引き込むためモックする。
const getNextQuestions = vi.fn();
const recordAnswer = vi.fn();
const revertAnswer = vi.fn();
vi.mock("#/server/quiz", () => ({
	getNextQuestions: (...args: unknown[]) => getNextQuestions(...args),
	recordAnswer: (...args: unknown[]) => recordAnswer(...args),
	revertAnswer: (...args: unknown[]) => revertAnswer(...args),
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn() }),
}));

const { useQuizSession } = await import("./useQuizSession");

// テスト終了時、末尾の in-flight プリフェッチ(queue が閾値以下になり fetchMore が
// 走る)がテスト後・環境破棄後に解決して React scheduler が window に触れるのを防ぐ。
// unmount で以後の effect を止め、act 内で残りのマイクロ/マクロタスクを drain する。
async function drainAndUnmount(unmount: () => void): Promise<void> {
	await act(async () => {
		unmount();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

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

		const { result, unmount } = renderHook(() =>
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
		await drainAndUnmount(unmount);
	});

	it("solved 除外でも正解済みしか返らない場合は loading に固着せず error へ落ち、retry で復帰する", async () => {
		// 除外に関わらず正解済みキーだけを返し続けるサーバ(正解済みが除外上限50を
		// 超える等で除外しきれない稀ケースの模擬)。remaining > 0 のまま補充できない。
		getNextQuestions.mockImplementation(async () => ({
			questions: [makeQuestion("solved-1")],
			remaining: 2,
			total: 2,
		}));

		const { result, unmount } = renderHook(() =>
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
		await drainAndUnmount(unmount);
	});
});

// Issue #255: 解答のサーバ保存が失敗しても、正解演出・残数・完了画面はローカルで
// 進んでしまう。ユーザが「保存された」と誤解しないよう、失敗を状態として表に出す。
describe("useQuizSession の解答記録失敗ハンドリング (#255)", () => {
	beforeEach(() => {
		getNextQuestions.mockReset();
		recordAnswer.mockReset();
		revertAnswer.mockReset();
		getNextQuestions.mockImplementation(async () => ({
			questions: [makeQuestion("q1"), makeQuestion("q2"), makeQuestion("q3")],
			remaining: 3,
			total: 3,
		}));
	});

	it("記録が401で失敗すると saveFailure に unauthorized が立つ", async () => {
		recordAnswer.mockRejectedValue(new Error(UNAUTHORIZED_MESSAGE));
		const { result, unmount } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], true),
		);
		await waitFor(() => expect(result.current.phase).toBe("answering"));
		expect(result.current.saveFailure).toBeNull();

		act(() => result.current.answer("a"));

		await waitFor(() =>
			expect(result.current.saveFailure).toEqual({
				kind: "unauthorized",
				count: 1,
			}),
		);
		// 保存は失敗しているが出題自体は継続できる(学習を止めない)。
		expect(result.current.phase).toBe("feedback");
		await drainAndUnmount(unmount);
	});

	it("401以外の失敗は unknown として立ち、連続失敗を数える", async () => {
		recordAnswer.mockRejectedValue(new Error("network down"));
		const { result, unmount } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], true),
		);
		await waitFor(() => expect(result.current.phase).toBe("answering"));

		act(() => result.current.answer("a"));
		await waitFor(() =>
			expect(result.current.saveFailure).toEqual({
				kind: "unknown",
				count: 1,
			}),
		);
		act(() => result.current.next());
		await waitFor(() => expect(result.current.phase).toBe("answering"));
		act(() => result.current.answer("a"));
		await waitFor(() =>
			expect(result.current.saveFailure).toEqual({
				kind: "unknown",
				count: 2,
			}),
		);
		await drainAndUnmount(unmount);
	});

	it("記録が1件でも通れば表示は解消する", async () => {
		recordAnswer.mockRejectedValueOnce(new Error("network down"));
		recordAnswer.mockResolvedValue(null);
		const { result, unmount } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], true),
		);
		await waitFor(() => expect(result.current.phase).toBe("answering"));

		act(() => result.current.answer("a"));
		await waitFor(() => expect(result.current.saveFailure).not.toBeNull());

		act(() => result.current.next());
		await waitFor(() => expect(result.current.phase).toBe("answering"));
		act(() => result.current.answer("a"));

		await waitFor(() => expect(result.current.saveFailure).toBeNull());
		await drainAndUnmount(unmount);
	});

	it("未ログインでは記録しないので保存失敗も出さない", async () => {
		// 未ログインは元から「実績が残らない」仕様。ここでバナーを出すと常時表示になる。
		recordAnswer.mockRejectedValue(new Error(UNAUTHORIZED_MESSAGE));
		const { result, unmount } = renderHook(() =>
			useQuizSession("bourgogne", ["colors"], false),
		);
		await waitFor(() => expect(result.current.phase).toBe("answering"));

		act(() => result.current.answer("a"));
		await waitFor(() => expect(result.current.phase).toBe("feedback"));

		expect(recordAnswer).not.toHaveBeenCalled();
		expect(result.current.saveFailure).toBeNull();
		await drainAndUnmount(unmount);
	});
});

// Issue #241: 呼び出し側が毎レンダー新しい quizTypes 配列を渡しても、内容が同じなら
// fetchMore の identity を据え置き、補充フェッチを再発火させないことを検証する。
describe("useQuizSession の quizTypes 参照ゆれ耐性", () => {
	beforeEach(() => {
		getNextQuestions.mockReset();
	});

	it("同一内容の quizTypes を新しい配列で渡し直しても再フェッチしない", async () => {
		// 補充しても新しい問題が返らず、キューが PREFETCH_THRESHOLD(2)以下に
		// 張り付く終盤の局面。ここで再レンダーのたびに補充が走るのが #241。
		getNextQuestions.mockResolvedValue({
			questions: [],
			remaining: 2,
			total: 2,
		});
		getNextQuestions.mockResolvedValueOnce({
			questions: [makeQuestion("k1"), makeQuestion("k2")],
			remaining: 2,
			total: 2,
		});

		const { result, rerender, unmount } = renderHook(
			({ quizTypes }: { quizTypes: QuizType[] }) =>
				useQuizSession("bourgogne", quizTypes, false),
			{ initialProps: { quizTypes: ["colors"] as QuizType[] } },
		);
		await waitFor(() => expect(result.current.current?.key).toBe("k1"));
		// 初回1回 + キューが閾値以下のため走る補充1回(内部で2 attempt)= 3回で落ち着く
		await waitFor(() => expect(getNextQuestions).toHaveBeenCalledTimes(3));

		const callsBefore = getNextQuestions.mock.calls.length;
		await act(async () => {
			// 内容は同じだが参照だけが変わる(parseQuizTypes 相当)
			rerender({ quizTypes: ["colors"] as QuizType[] });
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(getNextQuestions).toHaveBeenCalledTimes(callsBefore);

		await drainAndUnmount(unmount);
	});
});
