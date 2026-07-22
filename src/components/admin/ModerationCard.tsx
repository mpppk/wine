import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { BanControl } from "./BanControl";

export function ModerationCard({
	detail,
	isSelf,
}: {
	detail: AdminUserDetail;
	isSelf: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>モデレーション(管理操作)</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				<p className="text-sm text-muted-foreground">
					アカウント乗っ取り疑い・規約違反への対応。停止・失効は監査ログに記録されます。
				</p>
				<BanControl detail={detail} isSelf={isSelf} />
			</CardContent>
		</Card>
	);
}
