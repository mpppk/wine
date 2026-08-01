import { describe, expect, it } from "vitest";
import { countryForRegion, getCountry, WINE_COUNTRIES } from "./countries";
import { REGIONS } from "./regions";

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
		expect(getCountry("spain")).toBeUndefined();
	});
});
