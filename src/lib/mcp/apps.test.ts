import { describe, expect, it } from "vitest";
import { RELAY_READY_MESSAGE } from "#/lib/mcp-app/host-bridge";
import {
	AOP_MAP_RESOURCE_URI,
	buildAopMapAppHtml,
	buildAopMapUiResource,
	buildDrunkWineAppHtml,
	buildDrunkWineUiResource,
	buildEmbedMapUrl,
	DRUNK_WINE_RESOURCE_URI,
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

describe("buildDrunkWineAppHtml", () => {
	// フォーム本体は /embed/drunk-wine の実 React 実装(DrunkWineEmbedForm)で、
	// このHTMLはホストと自オリジンiframeを繋ぐ中継でしかない。中継が
	// ドメイン知識を持ち始めたら二重実装の再発なので、そこを回帰で押さえる。
	it("実装は /embed/drunk-wine を埋め込む中継である", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain(JSON.stringify(BASE));
		expect(html).toContain("/embed/drunk-wine");
	});

	it("エントリIDをURLパラメータで受け渡さない(IDOR防止)", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).not.toContain("?id=");
		expect(html).not.toContain("entry.id");
	});

	it("フォーム仕様・ツール名・パッチ規約を持たない(中継に徹する)", () => {
		const html = buildDrunkWineAppHtml(BASE);
		// ツール呼び出しの組み立ては App 側(host-bridge.ts)の責務
		expect(html).not.toContain("update_drunk_wine");
		expect(html).not.toContain("tools/call");
		// フィールド定義・品種マスタの埋め込みも不要になった
		expect(html).not.toContain("snakeKey");
		expect(html).not.toContain("pinot-noir");
		// 入力要素を自前で組み立てない
		expect(html).not.toContain("<textarea");
		expect(html).not.toContain("checkbox");
	});

	it("子フレーム・親フレーム以外からのメッセージを中継しない", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain("ev.source === frame.contentWindow");
		expect(html).toContain("ev.source === window.parent");
	});

	it("子の準備完了までホストからのメッセージをバッファする", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain("childReady");
		expect(html).toContain(RELAY_READY_MESSAGE.__wineRelay);
	});

	it("リソースURIは静的", () => {
		expect(DRUNK_WINE_RESOURCE_URI).toBe("ui://wine-aop/drunk-wine");
	});
});

describe("buildDrunkWineUiResource", () => {
	it("rawHtmlリソースとして編集フォームHTMLを内包する", () => {
		const res = buildDrunkWineUiResource(BASE, { id: "abc-123" });
		expect(res.type).toBe("resource");
		expect(res.resource.uri.startsWith("ui://wine-aop/drunk-wine")).toBe(true);
		expect(String(res.resource.mimeType)).toContain("text/html");
		expect(String(res.resource.text)).toContain("<!doctype html>");
		expect(String(res.resource.text)).toContain("/embed/drunk-wine");
	});
});
