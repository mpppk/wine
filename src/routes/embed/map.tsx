import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { AopDetailPanel } from "#/components/wine/AopDetailPanel";
import { AopMapView } from "#/components/wine/AopMapView";
import { CLASSIFICATIONS } from "#/lib/wine/map-style";
import { getRegion, getVariety, listAops } from "#/lib/wine/service";

const searchSchema = z.object({
	region: z.string().catch("bourgogne"),
	grape: z.string().optional(),
	aop: z.string().optional(),
});

// MCP Apps ホスト(Claude等)のiframeに埋め込まれる読み取り専用の地図ビュー。
// 公開データのみを表示するため認証は要求しない(サードパーティiframeでは
// セッションCookieが送られない環境が多い)。
export const Route = createFileRoute("/embed/map")({
	validateSearch: searchSchema,
	loaderDeps: ({ search }) => ({ region: search.region }),
	loader: ({ deps }) => {
		const region = getRegion(deps.region);
		if (!region?.enabled) {
			return { region: undefined, aops: [] };
		}
		return { region, aops: listAops({ regionId: region.id }) };
	},
	component: EmbedMapPage,
});

function EmbedMapPage() {
	const { region, aops } = Route.useLoaderData();
	const { grape, aop } = Route.useSearch();
	// embed内での選択はURLに反映せずローカルstateで持つ(ホスト側の履歴を汚さない)
	const [selectedAopId, setSelectedAopId] = useState<string | undefined>(aop);

	if (!region) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				指定された地域は利用できません。
			</p>
		);
	}

	const selectedAop = aops.find((a) => a.id === selectedAopId);
	const grapeVariety = grape ? getVariety(grape) : undefined;

	return (
		<div className="relative h-dvh w-full">
			<AopMapView
				region={region}
				aops={aops}
				selectedAopId={selectedAopId}
				grapeVarietyId={grapeVariety?.id}
				visibleClassifications={CLASSIFICATIONS}
				onSelectAop={setSelectedAopId}
				className="h-full w-full"
			/>

			<div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
				<span className="pointer-events-auto rounded-md border border-border bg-background/90 px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur">
					{region.nameJa}のAOP地図
					{grapeVariety && ` ・ ${grapeVariety.nameJa}が許可されたAOP`}
				</span>
				<a
					href={`/map/${region.id}${grape ? `?grape=${encodeURIComponent(grape)}` : ""}`}
					target="_blank"
					rel="noreferrer"
					className="pointer-events-auto rounded-md border border-border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
				>
					アプリで開く ↗
				</a>
			</div>

			{selectedAop && (
				<div className="absolute inset-x-2 bottom-2 max-h-[60%] overflow-y-auto rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur sm:inset-x-auto sm:right-2 sm:w-80">
					<AopDetailPanel
						aop={selectedAop}
						compact
						onClose={() => setSelectedAopId(undefined)}
					/>
				</div>
			)}
		</div>
	);
}
