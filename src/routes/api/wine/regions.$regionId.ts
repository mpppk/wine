import { createFileRoute } from "@tanstack/react-router";
import { AOP_KINDS } from "#/lib/wine/map-style";
import { getRegion, listAops } from "#/lib/wine/service";
import { AOP_TAG_IDS } from "#/lib/wine/tags";

// 地域詳細 + その地域のAOPメタデータ一覧(公開データ・認証不要)。
// ?grape=<varietyId> で「その品種が許可されているAOP」に絞り込める。
// ?kind=<AopKind> で区分、?tags=<tagId,...>(カンマ区切り・OR結合)でタグ絞り込み。
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
				const rawKind = url.searchParams.get("kind");
				const kind = AOP_KINDS.find((k) => k === rawKind);
				const rawTags = url.searchParams.get("tags")?.split(",") ?? [];
				const tags = AOP_TAG_IDS.filter((t) => rawTags.includes(t));
				const aops = listAops({
					regionId: region.id,
					grapeVarietyId: grape,
					kind,
					tags,
				});
				return Response.json(
					{ region, aops },
					{ headers: { "Cache-Control": "public, max-age=3600" } },
				);
			},
		},
	},
});
