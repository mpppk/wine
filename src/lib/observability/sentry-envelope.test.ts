import { describe, expect, it } from "vitest";
import { resolveServerEnvironment } from "./sentry-envelope";

// environment の対応が割れると同じ障害が2箇所に見える。対応表を固定する(#649)。
// envelope の手組みは #649 で削除した(送信は `withSentry` 初期化済みの SDK に委ねる)。

describe("resolveServerEnvironment", () => {
	// クライアント側(sentry-client.ts)と同じ対応。片方だけ足すと同じ障害が
	// 2つの environment に割れて見える。
	it.each([
		["https://wine.nibo.sh", "production"],
		["https://wine-preview.niboshi.workers.dev", "preview"],
		["https://claude-x-wine-preview.niboshi.workers.dev", "preview"],
		["http://localhost:3000", "local"],
		["http://127.0.0.1:8787", "local"],
	])("%s → %s", (url, expected) => {
		expect(resolveServerEnvironment(url)).toBe(expected);
	});

	it("未設定・壊れた値は local に倒す(本番のイベントに混ぜない)", () => {
		expect(resolveServerEnvironment(undefined)).toBe("local");
		expect(resolveServerEnvironment("not a url")).toBe("local");
	});
});
