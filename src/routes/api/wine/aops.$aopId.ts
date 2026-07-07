import { createFileRoute } from "@tanstack/react-router";
import { getAop, getRegion } from "#/lib/wine/service";

// AOP単体の詳細(公開データ・認証不要)。
export const Route = createFileRoute("/api/wine/aops/$aopId")({
	server: {
		handlers: {
			GET: ({ params }) => {
				const aop = getAop(params.aopId);
				if (!aop) {
					return Response.json({ error: "AOP not found" }, { status: 404 });
				}
				const region = getRegion(aop.region);
				return Response.json(
					{
						aop,
						region: region
							? {
									id: region.id,
									nameJa: region.nameJa,
									geojsonPath: region.geojsonPath,
									bounds: region.bounds,
								}
							: null,
					},
					{ headers: { "Cache-Control": "public, max-age=3600" } },
				);
			},
		},
	},
});
