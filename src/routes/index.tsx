import { createFileRoute, Link } from "@tanstack/react-router";
import { DashboardView } from "#/components/dashboard/DashboardView";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { getSession } from "#/server/auth";
import { getDashboard } from "#/server/dashboard";

export const Route = createFileRoute("/")({
	// ログイン時は学習ダッシュボード、未ログインは紹介カードを出す。
	// ダッシュボードはユーザ固有データなのでログイン時のみ取得する。
	beforeLoad: async () => {
		const session = await getSession();
		return { session };
	},
	loader: ({ context }) => (context.session ? getDashboard() : null),
	component: HomePage,
});

function HomePage() {
	const data = Route.useLoaderData();
	const { session } = Route.useRouteContext();

	if (data && session) {
		return <DashboardView data={data} userName={session.user.name ?? null} />;
	}

	return <IntroCard />;
}

function IntroCard() {
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
						ログインすると学習の記録が保存され、今日の学習状況やおすすめの学習を
						確認できます。
					</p>
					<div className="flex flex-wrap gap-2">
						<Button asChild>
							<Link to="/regions">地図でAOPを学ぶ</Link>
						</Button>
						<Button asChild>
							<Link to="/quiz">クイズでAOPを覚える</Link>
						</Button>
						<Button asChild variant="outline">
							<Link to="/login">ログイン</Link>
						</Button>
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
