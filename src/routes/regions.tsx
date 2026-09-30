import { createFileRoute, Link } from "@tanstack/react-router";
import { MapIcon } from "lucide-react";
import { PathBadge } from "#/components/learning-path/PathBadge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	type LearningPathStep,
	pickLearningPathStep,
	regionPathStatus,
	summarizeRegionProgress,
} from "#/lib/dashboard/learning-path";
import { groupRegionsByCountry } from "#/lib/wine/countries";
import { listRegions, type RegionSummary } from "#/lib/wine/service";
import { getAppellationTermJa } from "#/lib/wine/terminology";
import { getRouteSession } from "#/server/auth";
import { getQuizProgress } from "#/server/quiz";

export const Route = createFileRoute("/regions")({
	// 進捗バッジはユーザ固有データなのでログイン時のみ取得する
	beforeLoad: async () => {
		const session = await getRouteSession();
		return { isAuthenticated: !!session };
	},
	// 静的データはそのまま返し、学習パスの現在地/次だけ被せる(SSRにも乗る)
	loader: async ({
		context,
	}): Promise<{ regions: RegionSummary[]; step: LearningPathStep | null }> => {
		const regions = listRegions();
		if (!context.isAuthenticated) return { regions, step: null };
		const { regions: progress } = await getQuizProgress();
		return {
			regions,
			step: pickLearningPathStep(progress.map(summarizeRegionProgress)),
		};
	},
	component: RegionsPage,
});

function RegionsPage() {
	const { regions, step } = Route.useLoaderData();
	const enabled = regions.filter((r) => r.enabled);
	// 国の並び順は WINE_COUNTRIES 定義順、国内は REGIONS 定義順(決定的)。#586
	const groups = groupRegionsByCountry(enabled);

	return (
		<main className="mx-auto max-w-4xl px-4 py-8">
			<h1 className="text-2xl font-semibold">地域を選ぶ</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				地図でAOP(原産地呼称)の区画・土壌・品種を学べる地域を選択してください。
			</p>

			{groups.map(({ country, regions: countryRegions }) => (
				<section key={country.id} aria-labelledby={`country-${country.id}`}>
					<h2
						id={`country-${country.id}`}
						className="mt-8 flex items-baseline gap-2 text-lg font-semibold"
					>
						{country.nameJa}
						<span className="text-sm font-normal text-muted-foreground">
							{country.nameLocal} ・ {countryRegions.length}地域
						</span>
					</h2>
					<div className="mt-4 grid gap-4 sm:grid-cols-2">
						{countryRegions.map((region) => (
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
											<PathBadge status={regionPathStatus(region.id, step)} />
										</CardTitle>
										<CardDescription>
											{region.aopCount} {getAppellationTermJa(region.id)}
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
				</section>
			))}
		</main>
	);
}
