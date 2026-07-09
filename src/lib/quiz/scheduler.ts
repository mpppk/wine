import { parseKey } from "./keys";
import { type Rng, sampleWeighted, shuffle } from "./rng";

// 出題スケジューラ: ユーザの解答実績からキーごとの優先度を計算し、
// 「未出題 > 直近不正解 > 正解から日数が経過 > 直近正解」の順で優先出題する。
// 純関数のみで構成し、DBアクセスはサービス層が担う。

/** quiz_question_stat の行のうちスコア計算に必要な部分 */
export interface QuestionStatLike {
	correctCount: number;
	incorrectCount: number;
	streak: number;
	/** epoch ms */
	lastAnsweredAt: number;
}

/** 未出題キーのスコア(最優先) */
const UNSEEN_SCORE = 100;
/** 忘却曲線の満点日数: この日数を超えた正解済み問題は staleness 満点 */
const STALENESS_FULL_DAYS = 14;
/** 直近に解いた問題を同一セッションで連発させないためのクールダウン */
const COOLDOWN_MS = 10 * 60 * 1000;
/** スコア上位からこの件数をプールにして重み付き抽選する(決定的な反復を避ける) */
const POOL_SIZE = 40;

export function scoreCandidate(
	stat: QuestionStatLike | undefined,
	now: number,
): number {
	if (!stat) return UNSEEN_SCORE;
	const total = stat.correctCount + stat.incorrectCount;
	const accuracy = total > 0 ? stat.correctCount / total : 0;
	const daysSince = (now - stat.lastAnsweredAt) / (24 * 60 * 60 * 1000);
	const staleness = Math.min(Math.max(daysSince, 0) / STALENESS_FULL_DAYS, 1);
	let score =
		60 * (1 - accuracy) + 25 * staleness + (stat.streak === 0 ? 15 : 0);
	if (now - stat.lastAnsweredAt < COOLDOWN_MS) score *= 0.1;
	return score;
}

export interface PickQuestionKeysOptions {
	/** 出題スコープの全候補キー(listCandidates の結果) */
	candidates: readonly string[];
	/** ユーザの解答実績(キー → stat)。未出題キーはエントリなし */
	statsByKey: ReadonlyMap<string, QuestionStatLike>;
	count: number;
	/** クライアントが未消化のキュー等、除外するキー */
	excludeKeys?: readonly string[];
	now: number;
	rng: Rng;
}

/**
 * 次に出題するキーを count 件選ぶ。
 * スコア上位 POOL_SIZE 件から重み付き非復元サンプリングし、
 * 同一バッチ内では同じ subject AOP を避ける(プール枯渇時のみ許容)。
 */
export function pickQuestionKeys(options: PickQuestionKeysOptions): string[] {
	const { candidates, statsByKey, count, excludeKeys, now, rng } = options;
	const exclude = new Set(excludeKeys ?? []);
	const scored = candidates
		.filter((key) => !exclude.has(key))
		.map((key) => ({ key, score: scoreCandidate(statsByKey.get(key), now) }));

	// シャッフル後に安定ソートすることで同点キーの順序をランダムにする
	const pool = shuffle(scored, rng)
		.sort((a, b) => b.score - a.score)
		.slice(0, POOL_SIZE);

	const drawn = sampleWeighted(pool, pool.length, (c) => c.score + 1, rng);

	const picked: string[] = [];
	const deferred: string[] = [];
	const usedSubjects = new Set<string>();
	for (const { key } of drawn) {
		if (picked.length >= count) break;
		const subject = parseKey(key)?.aopId;
		if (subject && usedSubjects.has(subject)) {
			deferred.push(key);
			continue;
		}
		if (subject) usedSubjects.add(subject);
		picked.push(key);
	}
	// subject重複回避でプールが足りない場合は、後回しにしたキーで補充する
	for (const key of deferred) {
		if (picked.length >= count) break;
		picked.push(key);
	}
	return picked;
}
