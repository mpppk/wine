import { useQuery } from "@tanstack/react-query";
import {
	fetchLabelAnalysisJob,
	fetchLabelAnalysisJobBadge,
} from "#/components/cellar/label-analysis";
import { isTerminalLabelJobStatus } from "#/lib/ai/label-job";
import type {
	LabelAnalysisJobBadge,
	LabelAnalysisJobView,
} from "#/lib/services/label-job-service";

// エチケット解析ジョブのポーリング(#462)。`use-credit.ts` と同じ流儀で、クエリキーと
// フックをここに集める(画面ごとに useQuery を書くとキーがずれて無効化が効かなくなる)。

export const LABEL_JOB_QUERY_KEY = ["label-analysis-job"] as const;
export const LABEL_JOB_BADGE_QUERY_KEY = ["label-analysis-job-badge"] as const;

/**
 * ポーリング間隔。解析の実測は標準経路で約8秒、高精度経路(エージェントループ)で約31秒
 * (#461 の本番確認)。**待ち時間に対して十分細かく、かつ無駄打ちしない**ところを取る。
 * 終端に達したら `refetchInterval` を false にして止めるので、この間隔で回り続けるのは
 * 解析中だけ。
 */
const POLL_INTERVAL_MS = 3000;

/**
 * ジョブ1件をポーリングする。`jobId` が null の間は何も引かない。
 *
 * **終端に達したら自動で止まる**。止め忘れると、完了後もタブが開いている限り 3秒ごとに
 * D1 を引き続けることになる(状態取得は stale の決着も走らせるので、ただの読み取りより重い)。
 */
export function useLabelAnalysisJob(jobId: string | null) {
	return useQuery({
		queryKey: [...LABEL_JOB_QUERY_KEY, jobId],
		queryFn: () => fetchLabelAnalysisJob(jobId as string),
		enabled: jobId !== null,
		refetchInterval: (query) => {
			const data = query.state.data as LabelAnalysisJobView | undefined;
			if (!data) return POLL_INTERVAL_MS;
			return isTerminalLabelJobStatus(data.status) ? false : POLL_INTERVAL_MS;
		},
		// 解析中のジョブは「いま何件か」が意味を持つので、キャッシュを長く持たない。
		staleTime: 0,
	});
}

/**
 * マイセラーの解析バッジ。**未終端が残っている間だけポーリングする**——0件のときまで
 * 3秒ごとに引くと、解析を使っていない利用者にも常時 D1 アクセスが発生する。
 */
export function useLabelAnalysisJobBadge(enabled: boolean) {
	return useQuery({
		queryKey: LABEL_JOB_BADGE_QUERY_KEY,
		queryFn: () => fetchLabelAnalysisJobBadge(),
		enabled,
		refetchInterval: (query) => {
			const data = query.state.data as LabelAnalysisJobBadge | undefined;
			return data && data.activeCount > 0 ? POLL_INTERVAL_MS : false;
		},
		staleTime: 0,
	});
}
