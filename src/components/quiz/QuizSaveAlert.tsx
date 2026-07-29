import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import type { QuizSaveFailure } from "#/lib/quiz/save-status";

// 解答がサーバに保存できていないことを知らせるバナー(#255)。
// /quiz/play と地図内クイズ(MapQuizDialog)の両方が同じ表示・同じ導線を使うよう、
// 文言と再ログイン導線をこの1箇所に置く(経路ごとに書くと後発の経路で必ず漏れる)。

export function QuizSaveAlert({
	failure,
}: {
	failure: QuizSaveFailure | null;
}) {
	if (!failure) return null;
	const unauthorized = failure.kind === "unauthorized";
	const readOnly = failure.kind === "readOnly";
	return (
		<div
			// 解答直後に動的に現れるため、支援技術にも読み上げさせる。
			role="alert"
			className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
		>
			<TriangleAlertIcon
				className="mt-0.5 size-4 shrink-0 text-destructive"
				aria-hidden
			/>
			<div className="flex-1">
				<p className="font-medium text-destructive">解答が保存されていません</p>
				<p className="mt-0.5 text-muted-foreground">
					{unauthorized
						? "ログインの有効期限が切れました。再ログインするまで、この先の解答も進捗に記録されません。"
						: readOnly
							? "なりすまし中は閲覧のみ可能なため、解答は対象ユーザの進捗に記録されません。"
							: "サーバに記録できませんでした。通信環境を確認してください。回復すると自動で記録を再開します。"}
				</p>
				{unauthorized && (
					<Button asChild size="sm" variant="outline" className="mt-2">
						<Link to="/login">再ログイン</Link>
					</Button>
				)}
			</div>
		</div>
	);
}
