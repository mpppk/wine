import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	LOCALE_COOKIE_NAME,
	LOCALES,
	localeKeySchema,
	toLocaleKey,
} from "./locale";

// 表示ロケールの純ロジック(i18n Phase 1 #536)。D1・env に触れないため
// unit プロジェクト(jsdom)に置く。

describe("locale SSOT", () => {
	it("対応ロケールは ja と en", () => {
		expect([...LOCALES]).toEqual(["ja", "en"]);
	});

	it("既定は ja(Cookie が無ければ ja)", () => {
		expect(DEFAULT_LOCALE).toBe("ja");
	});

	it("Cookie 名は wine_locale", () => {
		expect(LOCALE_COOKIE_NAME).toBe("wine_locale");
	});

	it("toLocaleKey は許可リストだけを通す", () => {
		expect(toLocaleKey("ja")).toBe("ja");
		expect(toLocaleKey("en")).toBe("en");
		expect(toLocaleKey("fr")).toBeNull();
		expect(toLocaleKey("")).toBeNull();
		expect(toLocaleKey(null)).toBeNull();
		expect(toLocaleKey(undefined)).toBeNull();
		expect(toLocaleKey("JA")).toBeNull();
	});

	it("スキーマの拒否メッセージは利用者向けの日本語", () => {
		const result = localeKeySchema.safeParse("fr");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe("対応していない言語です。");
		}
	});
});
