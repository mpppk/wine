import { describe, expect, it } from "vitest";
import {
	normalizeCode,
	parseCampaignCodes,
	resolveExtensionDays,
} from "./campaign-codes";

describe("parseCampaignCodes", () => {
	it("CODE=days をカンマ区切りでパースし大文字化して保持する", () => {
		const map = parseCampaignCodes("wine7=7,SUMMER=14");
		expect(map.get("WINE7")).toBe(7);
		expect(map.get("SUMMER")).toBe(14);
		expect(map.size).toBe(2);
	});

	it("未設定・空文字は空Map", () => {
		expect(parseCampaignCodes(undefined).size).toBe(0);
		expect(parseCampaignCodes(null).size).toBe(0);
		expect(parseCampaignCodes("").size).toBe(0);
		expect(parseCampaignCodes("   ").size).toBe(0);
	});

	it("前後の空白を無視する", () => {
		const map = parseCampaignCodes("  WINE7 = 7 ,  FOO = 3 ");
		expect(map.get("WINE7")).toBe(7);
		expect(map.get("FOO")).toBe(3);
	});

	it("不正なエントリ(=無し・非数値・0以下・小数)は無視する", () => {
		const map = parseCampaignCodes("NOEQ,BAD=abc,ZERO=0,NEG=-5,FRAC=1.5,OK=7");
		expect(map.has("NOEQ")).toBe(false);
		expect(map.has("BAD")).toBe(false);
		expect(map.has("ZERO")).toBe(false);
		expect(map.has("NEG")).toBe(false);
		expect(map.has("FRAC")).toBe(false);
		expect(map.get("OK")).toBe(7);
		expect(map.size).toBe(1);
	});

	it("空コード(=の左が空)は無視する", () => {
		const map = parseCampaignCodes("=7,OK=3");
		expect(map.size).toBe(1);
		expect(map.get("OK")).toBe(3);
	});
});

describe("resolveExtensionDays", () => {
	const config = parseCampaignCodes("WINE7=7,SUMMER=14");

	it("有効コードは日数を返す(大文字小文字・空白無視)", () => {
		expect(resolveExtensionDays("WINE7", config)).toBe(7);
		expect(resolveExtensionDays("wine7", config)).toBe(7);
		expect(resolveExtensionDays("  Summer  ", config)).toBe(14);
	});

	it("未定義コード・空文字は null", () => {
		expect(resolveExtensionDays("NOPE", config)).toBeNull();
		expect(resolveExtensionDays("", config)).toBeNull();
		expect(resolveExtensionDays("  ", config)).toBeNull();
	});

	it("空Mapでは常に null", () => {
		expect(resolveExtensionDays("WINE7", new Map())).toBeNull();
	});
});

describe("normalizeCode", () => {
	it("前後空白除去と大文字化", () => {
		expect(normalizeCode("  wine7 ")).toBe("WINE7");
		expect(normalizeCode("")).toBe("");
	});
});
