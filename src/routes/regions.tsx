import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { MapIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { listRegions } from "#/lib/wine/service";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/regions")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	// 静的データなのでサーバ関数は不要。loaderで直接返すとSSRにも乗る。
	loader: () => ({ regions: listRegions() }),
	component: RegionsPage,
});

function RegionsPage() {
	const { regions } = Route.useLoaderData();
	const enabled = regions.filter((r) => r.enabled);
	const comingSoon = regions.filter((r) => !r.enabled);

	return (
		<main className="mx-auto max-w-4xl px-4 py-8">
			<h1 className="text-2xl font-semibold">地域を選ぶ</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				地図でAOP(原産地呼称)の区画・土壌・品種を学べる地域を選択してください。
			</p>

			<div className="mt-6 grid gap-4 sm:grid-cols-2">
				{enabled.map((region) => (
					<Link
						key={region.id}
						to="/map/$regionId"
						params={{ regionId: region.id }}
						className="group no-underline"
					>
						<Card className="h-full transition-colors group-hover:border-foreground/40">
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<MapIcon
										className="size-5 text-muted-foreground"
										aria-hidden
									/>
									{region.nameJa}
									<span className="text-sm font-normal text-muted-foreground">
										{region.nameLocal}
									</span>
								</CardTitle>
								<CardDescription>
									{region.countryJa} ・ {region.aopCount} AOP
								</CardDescription>
							</CardHeader>
							<CardContent>
								<p className="text-sm leading-relaxed text-muted-foreground">
									{region.description}
								</p>
							</CardContent>
						</Card>
					</Link>
				))}
			</div>

			<h2 className="mt-10 text-lg font-medium text-muted-foreground">
				準備中
			</h2>
			<div className="mt-3 grid gap-4 sm:grid-cols-3">
				{comingSoon.map((region) => (
					<Card key={region.id} className="opacity-60">
						<CardHeader>
							<CardTitle className="text-base">
								{region.nameJa}
								<span className="ml-2 text-xs font-normal text-muted-foreground">
									{region.nameLocal}
								</span>
							</CardTitle>
							<CardDescription>{region.countryJa}</CardDescription>
						</CardHeader>
						<CardContent>
							<p className="text-xs leading-relaxed text-muted-foreground">
								{region.description}
							</p>
						</CardContent>
					</Card>
				))}
			</div>
		</main>
	);
}
