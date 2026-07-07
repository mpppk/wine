import { describe, expect, it } from "vitest";
import {
	AOP_MAP_RESOURCE_URI,
	buildAopMapAppHtml,
	buildAopMapUiResource,
	buildEmbedMapUrl,
} from "./apps";

const BASE = "https://example.com";

describe("buildEmbedMapUrl", () => {
	it("regionのみ", () => {
		expect(buildEmbedMapUrl(BASE, { regionId: "bourgogne" })).toBe(
			"https://example.com/embed/map?region=bourgogne",
		);
	});

	it("品種と選択AOPをクエリに載せる", () => {
		const url = new URL(
			buildEmbedMapUrl(BASE, {
				regionId: "bourgogne",
				grapeVarietyId: "pinot-noir",
				aopId: "gevrey-chambertin",
			}),
		);
		expect(url.searchParams.get("region")).toBe("bourgogne");
		expect(url.searchParams.get("grape")).toBe("pinot-noir");
		expect(url.searchParams.get("aop")).toBe("gevrey-chambertin");
	});
});

describe("buildAopMapUiResource", () => {
	it("externalUrlリソースとして埋め込みURLを持つ", () => {
		const res = buildAopMapUiResource(BASE, {
			regionId: "beaujolais",
			grapeVarietyId: "gamay",
		});
		expect(res.type).toBe("resource");
		expect(res.resource.uri.startsWith("ui://wine-aop/map")).toBe(true);
		expect(String(res.resource.text)).toContain(
			"https://example.com/embed/map?region=beaujolais&grape=gamay",
		);
	});
});

describe("buildAopMapAppHtml", () => {
	it("ブリッジHTMLがベースURLとハンドシェイクを含む", () => {
		const html = buildAopMapAppHtml(BASE);
		expect(html).toContain(JSON.stringify(BASE));
		expect(html).toContain("ui/notifications/tool-result");
		expect(html).toContain("ui-lifecycle-iframe-ready");
		expect(html).toContain("/embed/map");
	});

	it("リソースURIは静的", () => {
		expect(AOP_MAP_RESOURCE_URI).toBe("ui://wine-aop/map");
	});
});
