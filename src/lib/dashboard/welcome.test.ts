import { describe, expect, it } from "vitest";
import {
	dismissWelcome,
	isFirstTimeVisitor,
	isWelcomeDismissed,
	shouldRedirectToWelcome,
} from "./welcome";

describe("isFirstTimeVisitor", () => {
	it("クイズもセラー登録も無ければ初回", () => {
		expect(isFirstTimeVisitor({ seen: 0, cellarTotalCount: 0 })).toBe(true);
	});

	it("クイズを解いていれば初回ではない", () => {
		expect(isFirstTimeVisitor({ seen: 1, cellarTotalCount: 0 })).toBe(false);
	});

	it("セラー登録があれば(未飲でも)初回ではない", () => {
		expect(isFirstTimeVisitor({ seen: 0, cellarTotalCount: 1 })).toBe(false);
	});
});

describe("shouldRedirectToWelcome", () => {
	it("初回かつ未表示なら誘導する", () => {
		expect(
			shouldRedirectToWelcome({
				seen: 0,
				cellarTotalCount: 0,
				welcomeDismissed: false,
			}),
		).toBe(true);
	});

	it("見終わっていたら(スキップ含む)誘導しない", () => {
		expect(
			shouldRedirectToWelcome({
				seen: 0,
				cellarTotalCount: 0,
				welcomeDismissed: true,
			}),
		).toBe(false);
	});

	it("活動済みユーザには誘導しない", () => {
		expect(
			shouldRedirectToWelcome({
				seen: 3,
				cellarTotalCount: 0,
				welcomeDismissed: false,
			}),
		).toBe(false);
		expect(
			shouldRedirectToWelcome({
				seen: 0,
				cellarTotalCount: 2,
				welcomeDismissed: false,
			}),
		).toBe(false);
	});
});

describe("dismissWelcome / isWelcomeDismissed", () => {
	// この環境の jsdom は localStorage を持たない(不透明オリジン)ため、
	// インメモリの最小スタブを差して振る舞いを検証する。
	function stubStorage() {
		const store = new Map<string, string>();
		const stub = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, String(value));
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => store.clear(),
		};
		Object.defineProperty(window, "localStorage", {
			value: stub,
			configurable: true,
		});
		return stub;
	}

	it("dismiss 後に dismissed になる", () => {
		const stub = stubStorage();
		expect(isWelcomeDismissed()).toBe(false);
		dismissWelcome();
		expect(isWelcomeDismissed()).toBe(true);
		expect(stub.getItem("welcome-dismissed")).toBe("1");
	});

	it("localStorage が使えなくても例外にしない", () => {
		Object.defineProperty(window, "localStorage", {
			get() {
				throw new Error("denied");
			},
			configurable: true,
		});
		expect(isWelcomeDismissed()).toBe(false);
		expect(() => dismissWelcome()).not.toThrow();
	});
});
