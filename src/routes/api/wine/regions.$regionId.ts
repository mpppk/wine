import { createFileRoute } from "@tanstack/react-router";
import { getRegion, listAops } from "#/lib/wine/service";
import type { Classification } from "#/lib/wine/types";

const CLASSIFICATIONS: Classification[] = ["regional", "village", "grand-cru"];

// 地域詳細 + その地域のAOPメタデータ一覧(公開データ・認証不要)。
// ?grape=<varietyId> で「その品種が許可されているAOP」に絞り込める。
// 境界GeoJSON本体は静的アセット(region.geojsonPath)として別途配信される。
export const Route = createFileRoute("/api/wine/regions/$regionId")({
	server: {
		handlers: {
			GET: ({ params, request }) => {
				const region = getRegion(params.regionId);
				if (!region) {
					return Response.json({ error: "Region not found" }, { status: 404 });
				}
				const url = new URL(request.url);
				const grape = url.searchParams.get("grape") ?? undefined;
				const rawClassification = url.searchParams.get("classification");
				const classification = CLASSIFICATIONS.find(
					(c) => c === rawClassification,
				);
				const aops = listAops({
					regionId: region.id,
					grapeVarietyId: grape,
					classification,
				});
				return Response.json(
					{ region, aops },
					{ headers: { "Cache-Control": "public, max-age=3600" } },
				);
			},
		},
	},
});
