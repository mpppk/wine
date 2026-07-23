import { describe, expect, it } from "vitest";
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
	it("ホスト仲介の tools/call とデュアルハンドシェイクを含む", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain(JSON.stringify(BASE));
		expect(html).toContain("tools/call");
		expect(html).toContain("update_drunk_wine");
		expect(html).toContain("ui/notifications/tool-result");
		expect(html).toContain("ui-lifecycle-iframe-ready");
	});

	it("エントリIDをURLパラメータで受け渡さない(IDOR防止)", () => {
		expect(buildDrunkWineAppHtml(BASE)).not.toContain("?id=");
	});

	it("品種マスタを埋め込み、CORSが必要なfetchをしない", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain("pinot-noir");
		expect(html).toContain("ピノ・ノワール");
		expect(html).not.toContain("fetch(");
	});

	it("親フレーム以外からのpostMessageを無視する", () => {
		expect(buildDrunkWineAppHtml(BASE)).toContain(
			"ev.source !== window.parent",
		);
	});

	it("写真は自オリジンのみ描画する(前方一致でなくorigin厳密比較)", () => {
		expect(buildDrunkWineAppHtml(BASE)).toContain(
			"u.origin === new URL(BASE_URL).origin",
		);
	});

	it("クリア(null)を含むパッチを送れる", () => {
		// 空欄への変更を null として送る diff ヘルパが存在すること
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain('=== "" ? null :');
	});

	it("フィールド定義(fields.ts)を埋め込み、汎用ループで描画する", () => {
		// ハードコードのフィールド一覧ではなく単一情報源から生成していること
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain("FIELD_DEFS");
		expect(html).toContain('"snakeKey":"grape_variety_ids"');
		expect(html).toContain('"clear":"emptyArray"');
	});

	it("代表1枚だけでなくphoto_urls(全写真)を描画する(#155のドリフト修正)", () => {
		const html = buildDrunkWineAppHtml(BASE);
		expect(html).toContain("entry.photo_urls");
		// 旧ホスト互換の代表1枚(photo_url)フォールバックも残す
		expect(html).toContain("entry.photo_url ?");
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
		expect(String(res.resource.text)).toContain("update_drunk_wine");
	});
});
