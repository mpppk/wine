import { describe, expect, it } from "vitest";
import {
	countryForRegion,
	getCountry,
	groupRegionsByCountry,
	WINE_COUNTRIES,
} from "./countries";
import { REGIONS } from "./regions";
import { listRegions } from "./service";

describe("WINE_COUNTRIES", () => {
	it("id は URL セーフなスラッグ(drunk_wine.country_id の公開キー)", () => {
		for (const country of WINE_COUNTRIES) {
			expect(country.id).toMatch(/^[a-z0-9-]+$/);
		}
	});

	it("全地域が国マスタへ突合できる(綴りずれで国が引けない地域を作らない)", () => {
		for (const region of REGIONS) {
			expect(
				countryForRegion(region),
				`地域 ${region.id} の country="${region.country}" が WINE_COUNTRIES と突合できない`,
			).toBeDefined();
		}
	});

	it("getCountry は未知の id に undefined を返す", () => {
		expect(getCountry("france")?.nameJa).toBe("フランス");
		expect(getCountry("chile")).toBeUndefined();
	});
});

describe("groupRegionsByCountry (#586)", () => {
	it("国の並び順は WINE_COUNTRIES 定義順で決定的", () => {
		const groups = groupRegionsByCountry(
			listRegions().filter((r) => r.enabled),
		);
		expect(groups.map((g) => g.country.id)).toEqual(
			WINE_COUNTRIES.map((c) => c.id).filter((id) =>
				listRegions().some((r) => r.enabled && countryForRegion(r)?.id === id),
			),
		);
	});

	it("全enabled地域を漏れなく国ごとにまとめる", () => {
		const enabled = listRegions().filter((r) => r.enabled);
		const groups = groupRegionsByCountry(enabled);
		expect(groups.flatMap((g) => g.regions)).toHaveLength(enabled.length);
		for (const group of groups) {
			for (const region of group.regions) {
				expect(countryForRegion(region)?.id).toBe(group.country.id);
			}
		}
		// 顔ぶれの固定: フランス8・イタリア3・スペイン1・ポルトガル1・ドイツ1
		const counts = Object.fromEntries(
			groups.map((g) => [g.country.id, g.regions.length]),
		);
		expect(counts).toEqual({
			france: 8,
			italy: 3,
			spain: 1,
			portugal: 1,
			germany: 1,
		});
	});

	it("国内の地域順は入力順(REGIONS定義順)を保つ", () => {
		const enabled = listRegions().filter((r) => r.enabled);
		const groups = groupRegionsByCountry(enabled);
		for (const group of groups) {
			const expected = enabled
				.filter((r) => countryForRegion(r)?.id === group.country.id)
				.map((r) => r.id);
			expect(group.regions.map((r) => r.id)).toEqual(expected);
		}
	});

	it("国マスタに無い地域は落とさず末尾にまとめる", () => {
		const unknown = {
			id: "unknown-region",
			nameJa: "未知",
			nameLocal: "Unknown",
			country: "Chile",
			countryJa: "チリ",
			enabled: true,
		} as const;
		const groups = groupRegionsByCountry([unknown]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.country.nameJa).toBe("チリ");
		expect(groups[0]?.regions.map((r) => r.id)).toEqual(["unknown-region"]);
	});
});
