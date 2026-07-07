import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	component: HomePage,
});

function HomePage() {
	const { data: session } = authClient.useSession();
	const user = session?.user;

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<Card>
				<CardHeader>
					<CardTitle className="text-2xl">ワインAOP学習アプリ</CardTitle>
					<CardDescription>
						国や地方から地図を辿り、区域ごとのAOP・土壌・主要ワイナリーを学べる
						アプリのベースです。ここから機能を作り込んでいきます。
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						{user?.name ? `${user.name} さん` : "ゲスト"}（{user?.email}）
						としてログイン中です。
					</p>
					<Button asChild className="self-start">
						<Link to="/profile">プロフィールを編集</Link>
					</Button>
				</CardContent>
			</Card>
		</main>
	);
}
