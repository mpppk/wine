import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { AdminCreditGrantForm } from "#/components/admin/AdminCreditGrantForm";
import { AdminPremiumExtensionForm } from "#/components/admin/AdminPremiumExtensionForm";
import { AuditLogCard } from "#/components/admin/AuditLogCard";
import { BasicInfoCard } from "#/components/admin/BasicInfoCard";
import { CouponCard } from "#/components/admin/CouponCard";
import { CreditCard } from "#/components/admin/CreditCard";
import { McpCard } from "#/components/admin/McpCard";
import { ModerationCard } from "#/components/admin/ModerationCard";
import { PlanCard } from "#/components/admin/PlanCard";
import { SessionCard } from "#/components/admin/SessionCard";
import { requireAdminBeforeLoad } from "#/lib/admin/route-guard";
import { authClient } from "#/lib/auth-client";
import { adminGetUserDetail } from "#/server/admin";

export const Route = createFileRoute("/admin/$userId")({
	beforeLoad: requireAdminBeforeLoad,
	loader: async ({ params }) => {
		const detail = await adminGetUserDetail({
			data: { userId: params.userId },
		});
		if (!detail) throw notFound();
		return detail;
	},
	component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
	const detail = Route.useLoaderData();
	const { data: session } = authClient.useSession();
	const isSelf = session?.user.id === detail.user.id;

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-6">
				<Link
					to="/admin"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-4" aria-hidden />
					ユーザー管理に戻る
				</Link>
			</div>
			<h1 className="mb-6 text-2xl font-bold">ユーザー詳細</h1>
			<div className="flex flex-col gap-6">
				<BasicInfoCard detail={detail} />
				<ModerationCard detail={detail} isSelf={isSelf} />
				<PlanCard detail={detail} />
				<SessionCard detail={detail} isSelf={isSelf} />
				<McpCard detail={detail} />
				<CreditCard detail={detail} />
				<AdminCreditGrantForm
					userId={detail.user.id}
					userName={detail.user.name}
				/>
				<AdminPremiumExtensionForm detail={detail} />
				<CouponCard detail={detail} />
				<AuditLogCard detail={detail} />
			</div>
		</main>
	);
}
