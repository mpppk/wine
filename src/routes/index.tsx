import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/")({
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
						地図から地域ごとのAOP(原産地呼称)の区画・土壌・ブドウ品種・
						主要な生産者を学べるアプリです。
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						{user
							? `${user.name ? `${user.name} さん` : "ゲスト"}（${user.email}）としてログイン中です。`
							: "ログインすると学習の記録が保存されます。"}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button asChild>
							<Link to="/regions">地図でAOPを学ぶ</Link>
						</Button>
						<Button asChild>
							<Link to="/quiz">クイズでAOPを覚える</Link>
						</Button>
						{user ? (
							<Button asChild variant="outline">
								<Link to="/profile">プロフィールを編集</Link>
							</Button>
						) : (
							<Button asChild variant="outline">
								<Link to="/login">ログイン</Link>
							</Button>
						)}
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
