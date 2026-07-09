import { useCallback, useEffect, useRef, useState } from "react";
import type { QuizQuestion, QuizType } from "#/lib/quiz/types";
import type { AnswerSnapshot } from "#/lib/services/quiz-service";
import type { RegionId } from "#/lib/wine/types";
import { getNextQuestions, recordAnswer, revertAnswer } from "#/server/quiz";

// エンドレス出題のキュー管理フック。
// - 初回に5問取得し、残り2問以下になったら追加をプリフェッチする
// - 解答は即座に記録する(失敗しても出題は続行)。記録時に更新直前の行スナップショットを
//   受け取り、リセット(回答を取り消す)時にそれでサーバ側を復元する。
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
	// 直近の解答記録(リセット用)。promise は更新前スナップショットに解決する。
	// 記録失敗時は null に解決し、その場合は復元不要
	const recordRef = useRef<{
		questionKey: string;
		promise: Promise<AnswerSnapshot | null>;
	} | null>(null);
	// 記録・取り消しを直列化する。同じ行を read-then-write するため、リセット直後の
	// 再回答でも record→revert→record の順序を保ち、最終状態が壊れないようにする
	const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve());

	// op を直前の変更の後に実行するようキューへ繋ぐ。チェーンは失敗しても続行する
	const enqueueMutation = useCallback(<T>(op: () => Promise<T>): Promise<T> => {
		const run = mutationChainRef.current.then(op, op);
		mutationChainRef.current = run.catch(() => {});
		return run;
	}, []);

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

	// キューを1問進める(next / skip 共通)。recentKeys の更新は各呼び出し側が担う
	const advance = useCallback(() => {
		setSelectedOptionId(undefined);
		setQueue((prev) => prev.slice(1));
		setPhase(queue.length > 1 ? "answering" : "loading");
	}, [queue.length]);

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
			// 記録は即時。失敗しても学習は続行できる。返ってくる更新前スナップショットは
			// リセット用に保持する。未ログイン時はサーバに実績を残せないのでスキップ
			if (isLoggedIn) {
				recordRef.current = {
					questionKey: current.key,
					promise: enqueueMutation(() =>
						recordAnswer({ data: { questionKey: current.key, wasCorrect } }),
					).catch((error) => {
						console.error("failed to record quiz answer", error);
						return null;
					}),
				};
			} else {
				recordRef.current = null;
			}
		},
		[current, phase, isLoggedIn, enqueueMutation],
	);

	// 回答を取り消してやり直す(誤タップ救済)。ローカル状態を回答前へ戻し、
	// 記録済みならサーバも更新前スナップショットで復元する
	const reset = useCallback(() => {
		if (phase !== "feedback" || !current) return;
		const wasCorrect = selectedOptionId === current.correctOptionId;
		setSelectedOptionId(undefined);
		setPhase("answering");
		setTally((t) => ({
			answered: t.answered - 1,
			correct: t.correct - (wasCorrect ? 1 : 0),
		}));
		// answer で積んだ末尾(= current.key)を取り除き「未解答」に戻す
		const keys = recentKeysRef.current;
		if (keys[keys.length - 1] === current.key) {
			recentKeysRef.current = keys.slice(0, -1);
		}
		// サーバ復元: 復元処理を同じチェーンへ繋ぐ(await はチェーン内で行い、
		// enqueue 自体は同期。これでリセット直後の再回答より前に revert が並ぶ)。
		// revert は実行時に記録のスナップショットを待って確定する。記録失敗なら不要
		const pending = recordRef.current;
		recordRef.current = null;
		if (pending && pending.questionKey === current.key) {
			enqueueMutation(async () => {
				const prior = await pending.promise;
				if (prior) {
					await revertAnswer({ data: { questionKey: current.key, prior } });
				}
			}).catch((error) => {
				console.error("failed to revert quiz answer", error);
			});
		}
	}, [phase, current, selectedOptionId, enqueueMutation]);

	const next = useCallback(() => {
		if (phase !== "feedback") return;
		recordRef.current = null; // この問題は確定
		advance();
	}, [phase, advance]);

	// 回答せず今の問題を飛ばす。記録もタリーも増やさず、直後の再出題だけ避ける
	const skip = useCallback(() => {
		if (phase !== "answering" || !current) return;
		recentKeysRef.current = [
			...recentKeysRef.current.slice(-(RECENT_KEYS_LIMIT - 1)),
			current.key,
		];
		advance();
	}, [phase, current, advance]);

	return { phase, current, selectedOptionId, tally, answer, reset, skip, next };
}
