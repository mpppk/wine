import { useCallback, useEffect, useRef, useState } from "react";
import type { QuizQuestion, QuizType } from "#/lib/quiz/types";
import type { RegionId } from "#/lib/wine/types";
import { getNextQuestions, recordAnswer } from "#/server/quiz";

// エンドレス出題のキュー管理フック。
// - 初回に5問取得し、残り2問以下になったら追加をプリフェッチする
// - 解答は fire-and-forget で記録する(失敗しても出題は続行)。
//   未ログイン時は記録をスキップする(回答はできるが実績は残らない)
// - excludeKeys(キュー内 + 直近解答分)で同じ問題の連続出題を防ぐ

const BATCH_SIZE = 5;
const PREFETCH_THRESHOLD = 2;
/** サーバに渡す「直近解答済みキー」の上限。候補が少ない地域でも出題が
 * 枯渇しないよう、入力スキーマの上限(50)より十分小さくする */
const RECENT_KEYS_LIMIT = 20;

export type QuizPhase = "loading" | "answering" | "feedback" | "empty";

export interface QuizTally {
	answered: number;
	correct: number;
}

export function useQuizSession(
	regionId: RegionId,
	quizTypes: QuizType[],
	isLoggedIn: boolean,
	// 指定時は選択AOPとその階層近傍に出題を絞る(地図ページのスコープ付きクイズ)。
	// セッションのリセットは呼び出し側の key 再マウントで行う
	scopeAopId?: string,
) {
	const [queue, setQueue] = useState<QuizQuestion[]>([]);
	const [phase, setPhase] = useState<QuizPhase>("loading");
	const [selectedOptionId, setSelectedOptionId] = useState<string>();
	const [tally, setTally] = useState<QuizTally>({ answered: 0, correct: 0 });
	const recentKeysRef = useRef<string[]>([]);
	const fetchingRef = useRef(false);
	const exhaustedRef = useRef(false);

	const current: QuizQuestion | undefined = queue[0];

	const fetchMore = useCallback(
		async (queuedKeys: string[]) => {
			if (fetchingRef.current || exhaustedRef.current) return;
			fetchingRef.current = true;
			try {
				const { questions } = await getNextQuestions({
					data: {
						regionId,
						quizTypes,
						count: BATCH_SIZE,
						excludeKeys: [...queuedKeys, ...recentKeysRef.current],
						scopeAopId,
					},
				});
				if (questions.length === 0) {
					// 除外キーで候補が尽きた(候補が少ない地域)。直近履歴を捨てて
					// 再出題を許可する。それでも0件なら候補自体が無い
					if (recentKeysRef.current.length > 0) {
						recentKeysRef.current = [];
					} else {
						exhaustedRef.current = true;
					}
					return;
				}
				setQueue((prev) => {
					const known = new Set(prev.map((q) => q.key));
					return [...prev, ...questions.filter((q) => !known.has(q.key))];
				});
			} catch (error) {
				console.error("failed to fetch quiz questions", error);
			} finally {
				fetchingRef.current = false;
			}
		},
		[regionId, quizTypes, scopeAopId],
	);

	// 初回ロードとプリフェッチ
	useEffect(() => {
		if (queue.length <= PREFETCH_THRESHOLD) {
			void fetchMore(queue.map((q) => q.key)).then(() => {
				setQueue((prev) => {
					if (prev.length === 0 && exhaustedRef.current) {
						setPhase("empty");
					}
					return prev;
				});
			});
		}
	}, [queue, fetchMore]);

	// キューに問題が届いたら出題フェーズへ
	useEffect(() => {
		if (phase === "loading" && current) {
			setPhase("answering");
		}
	}, [phase, current]);

	const answer = useCallback(
		(optionId: string) => {
			if (!current || phase !== "answering") return;
			const wasCorrect = optionId === current.correctOptionId;
			setSelectedOptionId(optionId);
			setPhase("feedback");
			setTally((t) => ({
				answered: t.answered + 1,
				correct: t.correct + (wasCorrect ? 1 : 0),
			}));
			recentKeysRef.current = [
				...recentKeysRef.current.slice(-(RECENT_KEYS_LIMIT - 1)),
				current.key,
			];
			// 記録は fire-and-forget: 失敗しても学習は続行できる。
			// 未ログイン時はサーバに実績を残せないのでスキップ
			if (isLoggedIn) {
				recordAnswer({
					data: { questionKey: current.key, wasCorrect },
				}).catch((error) => {
					console.error("failed to record quiz answer", error);
				});
			}
		},
		[current, phase, isLoggedIn],
	);

	const next = useCallback(() => {
		if (phase !== "feedback") return;
		setSelectedOptionId(undefined);
		setQueue((prev) => prev.slice(1));
		setPhase(queue.length > 1 ? "answering" : "loading");
	}, [phase, queue.length]);

	return { phase, current, selectedOptionId, tally, answer, next };
}
