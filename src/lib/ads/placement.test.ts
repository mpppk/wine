import { describe, expect, it } from "vitest";
import { isAdBannerPath, shouldShowQuizAd } from "./placement";

describe("isAdBannerPath", () => {
	it("学習系ページ(地図・クイズ・セラー)は対象", () => {
		expect(isAdBannerPath("/map/bourgogne")).toBe(true);
		expect(isAdBannerPath("/quiz")).toBe(true);
		expect(isAdBannerPath("/quiz/progress")).toBe(true);
		expect(isAdBannerPath("/cellar")).toBe(true);
		expect(isAdBannerPath("/cellar/map")).toBe(true);
		expect(isAdBannerPath("/cellar/new")).toBe(true);
		expect(isAdBannerPath("/cellar/abc/edit")).toBe(true);
	});

	it("/quiz/play はsticky操作バーと競合するため対象外", () => {
		expect(isAdBannerPath("/quiz/play")).toBe(false);
	});

	it("学習系以外のページは対象外", () => {
		expect(isAdBannerPath("/")).toBe(false);
		expect(isAdBannerPath("/regions")).toBe(false);
		expect(isAdBannerPath("/pricing")).toBe(false);
		expect(isAdBannerPath("/profile")).toBe(false);
		expect(isAdBannerPath("/login")).toBe(false);
		expect(isAdBannerPath("/embed/map")).toBe(false);
	});

	it("prefixに前方一致するだけの別パスは対象外", () => {
		expect(isAdBannerPath("/quizzes")).toBe(false);
		expect(isAdBannerPath("/cellars")).toBe(false);
		expect(isAdBannerPath("/mapping")).toBe(false);
	});
});

describe("shouldShowQuizAd", () => {
	it("10問回答ごとに true", () => {
		expect(shouldShowQuizAd(10)).toBe(true);
		expect(shouldShowQuizAd(20)).toBe(true);
	});

	it("それ以外は false(0問=セッション開始直後を含む)", () => {
		expect(shouldShowQuizAd(0)).toBe(false);
		expect(shouldShowQuizAd(1)).toBe(false);
		expect(shouldShowQuizAd(9)).toBe(false);
		expect(shouldShowQuizAd(11)).toBe(false);
	});
});
