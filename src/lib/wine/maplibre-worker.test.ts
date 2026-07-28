import { afterEach, describe, expect, it, vi } from "vitest";
import { hasOpaqueOrigin, resolveMaplibreWorkerUrl } from "./maplibre-worker";

// MCP Apps ホストの sandbox iframe(不透明オリジン)で地図が白くなる問題(#194)の
// 判定と差し替えロジック。実機でしか再現しない類の不具合なので、
// 「どの値を見て不透明と判断するか」だけでも静的に固定しておく。

const WORKER_URL = "/assets/maplibre-gl-worker-abc123.js";

function stubOrigin(value: string) {
	vi.spyOn(window, "origin", "get").mockReturnValue(value);
}

/** URL.createObjectURL を差し替えて blob URL のオリジンを模す。 */
function stubBlobOrigin(prefix: string) {
	vi.spyOn(URL, "createObjectURL").mockReturnValue(`${prefix}/deadbeef`);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hasOpaqueOrigin", () => {
	it("window.origin が 'null' なら不透明", () => {
		stubOrigin("null");
		expect(hasOpaqueOrigin()).toBe(true);
	});

	it("window.origin が通常でも blob URL が blob:null なら不透明", () => {
		// location.origin ではなく window.origin を見る理由の裏取り。実機では
		// 同じ文書で location.origin が元のオリジン / window.origin が null になる。
		stubOrigin("https://wine.example");
		stubBlobOrigin("blob:null");
		expect(hasOpaqueOrigin()).toBe(true);
	});

	it("通常のオリジンなら不透明ではない", () => {
		stubOrigin("https://wine.example");
		stubBlobOrigin("blob:https://wine.example");
		expect(hasOpaqueOrigin()).toBe(false);
	});
});

describe("resolveMaplibreWorkerUrl", () => {
	it("通常のオリジンでは URL をそのまま返す(fetch しない)", async () => {
		stubOrigin("https://wine.example");
		stubBlobOrigin("blob:https://wine.example");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await resolveMaplibreWorkerUrl(WORKER_URL)).toBe(WORKER_URL);
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("不透明オリジンではスクリプトを取得して blob URL に差し替える", async () => {
		stubOrigin("null");
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:null/worker");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => "self.onmessage=()=>{}",
			}),
		);
		expect(await resolveMaplibreWorkerUrl(WORKER_URL)).toBe("blob:null/worker");
		vi.unstubAllGlobals();
	});

	it("取得に失敗しても例外にせず元の URL を返す(地図の初期化を止めない)", async () => {
		stubOrigin("null");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
		expect(await resolveMaplibreWorkerUrl(WORKER_URL)).toBe(WORKER_URL);
		vi.unstubAllGlobals();
	});

	it("2xx 以外でも元の URL を返す", async () => {
		stubOrigin("null");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 404 }),
		);
		expect(await resolveMaplibreWorkerUrl(WORKER_URL)).toBe(WORKER_URL);
		vi.unstubAllGlobals();
	});
});
