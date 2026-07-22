import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { formatDateTime } from "./format";
import { InfoRow } from "./InfoRow";

export function BasicInfoCard({ detail }: { detail: AdminUserDetail }) {
	const u = detail.user;
	return (
		<Card>
			<CardHeader>
				<CardTitle>基本情報</CardTitle>
			</CardHeader>
			<CardContent>
				{u.banned && (
					<div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
						<p className="font-medium">このアカウントは利用停止中です</p>
						{u.banReason && <p className="mt-1">理由: {u.banReason}</p>}
						{u.banExpires && (
							<p className="mt-1">解除予定: {formatDateTime(u.banExpires)}</p>
						)}
					</div>
				)}
				<div className="mb-4 flex items-center gap-3">
					{u.image ? (
						<img
							src={u.image}
							alt=""
							className="size-12 rounded-full object-cover"
						/>
					) : (
						<span className="flex size-12 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground">
							{u.name.charAt(0).toUpperCase()}
						</span>
					)}
					<div>
						<p className="font-medium">{u.name}</p>
						<p className="text-sm text-muted-foreground">{u.email}</p>
					</div>
				</div>
				<dl className="divide-y divide-border">
					<InfoRow label="ユーザーID">
						<code className="text-xs">{u.id}</code>
					</InfoRow>
					<InfoRow label="メール確認">
						{u.emailVerified ? "確認済み" : "未確認"}
					</InfoRow>
					<InfoRow label="ロール">{u.role ?? "user"}</InfoRow>
					<InfoRow label="AIモデル設定">{u.preferredAiModel ?? "既定"}</InfoRow>
					<InfoRow label="Stripe顧客ID">
						{u.stripeCustomerId ? (
							<code className="text-xs">{u.stripeCustomerId}</code>
						) : (
							"-"
						)}
					</InfoRow>
					<InfoRow label="登録日時">{formatDateTime(u.createdAt)}</InfoRow>
					<InfoRow label="更新日時">{formatDateTime(u.updatedAt)}</InfoRow>
				</dl>
			</CardContent>
		</Card>
	);
}
