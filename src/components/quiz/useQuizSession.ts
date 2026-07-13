import { useRouter } from "@tanstack/react-router";
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

// done = スコープ内の問題を全問正解して終了。empty = 出題できる問題が元々0件。
export type QuizPhase = "loading" | "answering" | "feedback" | "empty" | "done";

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
	const router = useRouter();
	const [queue, setQueue] = useState<QuizQuestion[]>([]);
	const [phase, setPhase] = useState<QuizPhase>("loading");
	const [selectedOptionId, setSelectedOptionId] = useState<string>();
	const [tally, setTally] = useState<QuizTally>({ answered: 0, correct: 0 });
	// まだ正解していない問題数。初回fetchのサーバ値でシードし、以後は正解/取り消しで
	// クライアント側で増減する(ログイン=永続実績ベース、未ログイン=セッション内)。
	const [remaining, setRemainingState] = useState<number | null>(null);
	// クロージャのstale値を避けるため remaining をrefにも保持する
	const remainingRef = useRef<number | null>(null);
	const applyRemaining = useCallback((value: number) => {
		remainingRef.current = value;
		setRemainingState(value);
	}, []);
	// このセッションで正解済みのキー。未ログイン時の再出題防止と残数の二重減算防止に使う
	const solvedKeysRef = useRef<Set<string>>(new Set());
	const seededRef = useRef(false);
	// スコープに問題が1問でも存在したか(全問正解の"done"と問題0件の"empty"を区別)
	const hasQuestionsRef = useRef(false);
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
	// このセッションで1件でもサーバ書き込み(記録)を行ったか。アンマウント時に
	// ローダーを再検証するか判定する(未ログイン/無操作では再取得しない)
	const didRecordRef = useRef(false);

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
				// 未消化キーで候補が尽きたら直近履歴を捨てて1回だけ再取得する。
				// 未正解が数問だけ残るスコープ(例: 地図のAOP単位クイズ)では、
				// 残りの問題が recentKeys に入って除外され続けるため、ここで
				// 再取得しないと「問題を準備中…」のまま止まってしまう。
				for (let attempt = 0; attempt < 2; attempt++) {
					const {
						questions,
						remaining: serverRemaining,
						total,
					} = await getNextQuestions({
						data: {
							regionId,
							quizTypes,
							count: BATCH_SIZE,
							excludeKeys: [...queuedKeys, ...recentKeysRef.current],
							scopeAopId,
						},
					});
					// 残数はサーバの初回値をシード(ログインは永続的な正解済みを反映)。
					// 以後の増減はクライアント側で行うため、上書きは初回のみ
					if (!seededRef.current) {
						seededRef.current = true;
						hasQuestionsRef.current = total > 0;
						applyRemaining(serverRemaining);
					}
					// このセッションで正解済みのキーは除く(未ログインはサーバが除外できないため)
					const fresh = questions.filter(
						(q) => !solvedKeysRef.current.has(q.key),
					);
					if (fresh.length > 0) {
						setQueue((prev) => {
							const known = new Set(prev.map((q) => q.key));
							return [...prev, ...fresh.filter((q) => !known.has(q.key))];
						});
						return;
					}
					// 直近履歴が残っていれば捨てて再取得。無ければ未正解は残っておらず、
					// 完了判定(remaining === 0)はプリフェッチ側の then で行う
					if (recentKeysRef.current.length > 0) {
						recentKeysRef.current = [];
						continue;
					}
					return;
				}
			} catch (error) {
				console.error("failed to fetch quiz questions", error);
			} finally {
				fetchingRef.current = false;
			}
		},
		[regionId, quizTypes, scopeAopId, applyRemaining],
	);

	// 初回ロードとプリフェッチ
	useEffect(() => {
		if (queue.length <= PREFETCH_THRESHOLD) {
			void fetchMore(queue.map((q) => q.key)).then(() => {
				setQueue((prev) => {
					// キューが空で未正解も残っていなければ終了。fetchMore は未正解が
					// あれば必ず補充するので、空のまま = remaining 0(全問正解 or 出題不可)
					if (
						prev.length === 0 &&
						seededRef.current &&
						remainingRef.current === 0
					) {
						exhaustedRef.current = true;
						// 問題が1問でもあれば全問正解での完了、元々0件なら出題不可
						setPhase(hasQuestionsRef.current ? "done" : "empty");
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

	// セッション終了(アンマウント)時に、解答を記録していればローダーを再検証する。
	// 地図のクイズはモーダルで完結し、閉じても遷移が起きないためローダー由来の
	// 進捗(solved/total)が更新されない。記録の書き込みが確定してから invalidate し、
	// リスト/地図へ戻った時点で最新値を反映させる。未ログイン/無操作では走らせない。
	useEffect(() => {
		return () => {
			if (!didRecordRef.current) return;
			void mutationChainRef.current
				.then(() => router.invalidate())
				.catch(() => {});
		};
	}, [router]);

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
			// 正解した問題はクリア済みとして残数を1減らし、以後の再出題から除外する
			if (wasCorrect && !solvedKeysRef.current.has(current.key)) {
				solvedKeysRef.current.add(current.key);
				applyRemaining(Math.max(0, (remainingRef.current ?? 0) - 1));
			}
			recentKeysRef.current = [
				...recentKeysRef.current.slice(-(RECENT_KEYS_LIMIT - 1)),
				current.key,
			];
			// 記録は即時。失敗しても学習は続行できる。返ってくる更新前スナップショットは
			// リセット用に保持する。未ログイン時はサーバに実績を残せないのでスキップ
			if (isLoggedIn) {
				didRecordRef.current = true;
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
		[current, phase, isLoggedIn, enqueueMutation, applyRemaining],
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
		// 正解としてクリア扱いにしていたら取り消し、残数を戻す
		if (wasCorrect && solvedKeysRef.current.has(current.key)) {
			solvedKeysRef.current.delete(current.key);
			applyRemaining((remainingRef.current ?? 0) + 1);
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
	}, [phase, current, selectedOptionId, enqueueMutation, applyRemaining]);

	const next = useCallback(() => {
		if (phase !== "feedback") return;
		recordRef.current = null; // この問題は確定
		// 未正解が残っていなければ全問正解での完了。fetch待ちを挟まず即座に完了画面へ
		if (remainingRef.current === 0) {
			exhaustedRef.current = true; // 以降のプリフェッチを止める
			setPhase("done");
			return;
		}
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

	return {
		phase,
		current,
		selectedOptionId,
		tally,
		remaining,
		answer,
		reset,
		skip,
		next,
	};
}
