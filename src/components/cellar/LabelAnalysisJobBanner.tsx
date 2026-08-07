import { Link } from "@tanstack/react-router";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useLabelAnalysisJobBadge } from "#/components/cellar/use-label-analysis-job";
import { Button } from "#/components/ui/button";

// マイセラーのエチケット解析バッジ(Issue #462)。
//
// 「投入したらページを離れてよい」を成立させるには、**離れた先で完了が分かる**必要が
// ある。#460 の決定どおりまずアプリ内通知で、マイセラーを開けば解析中と受け取り待ちが
// 分かる形にする(Web Push は Service Worker が未整備なので将来)。
//
// 受け取り待ちをタップすると `/cellar/new?labelJob=<jobId>` が候補入りで開く。
// **一覧を引き直さずに遷移できる**よう、件数と一緒に次に受け取るIDをサーバから貰う。

export function LabelAnalysisJobBanner({
	/** 未ログインでは引かない(401 を毎回踏むだけになる)。 */
	enabled,
}: {
	enabled: boolean;
}) {
	const { data } = useLabelAnalysisJobBadge(enabled);
	if (!data || (data.activeCount === 0 && data.readyCount === 0)) return null;

	const ready = data.readyCount > 0 && data.nextReadyJobId !== undefined;
	return (
		<div
			className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/50 px-3 py-2"
			// 解析中→完了の切り替わりは利用者の操作を起点にしないので、読み上げに乗せる。
			// polite にするのは、入力中の読み上げを遮らないため。
			aria-live="polite"
		>
			<SparklesIcon
				className="size-4 shrink-0 text-muted-foreground"
				aria-hidden
			/>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
				{data.activeCount > 0 && (
					<span className="flex items-center gap-1.5 text-muted-foreground">
						<Loader2Icon className="size-3.5 animate-spin" aria-hidden />
						エチケットを解析中 {data.activeCount}件
					</span>
				)}
				{ready && (
					<span className="font-medium">
						解析が完了しました {data.readyCount}件
					</span>
				)}
			</div>
			{ready && data.nextReadyJobId && (
				<Button asChild size="sm" className="ml-auto">
					<Link to="/cellar/new" search={{ labelJob: data.nextReadyJobId }}>
						結果を見て登録する
					</Link>
				</Button>
			)}
		</div>
	);
}
