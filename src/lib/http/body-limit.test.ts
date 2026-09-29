import { describe, expect, it } from "vitest";
import {
	BODY_TOO_LARGE_MESSAGE,
	DEFAULT_MAX_BODY_BYTES,
	enforceBodyLimit,
	MCP_MAX_BODY_BYTES,
	resolveBodyLimit,
} from "./body-limit";

// worker.ts の全体関門(#639)の回帰テスト。#398 と同じ穴——Content-Length を
// 信用した事前チェックだけでは、ヘッダの無い chunked 送信が素通りして本文全体が
// isolate メモリへバッファされる——を JSON 系の入口(/api/mcp・/api/auth/*・
// server fn)で塞ぐことを固定する。

/** chunked 送信の再現: content-length を持たないストリーム POST。 */
function streamedRequest(
	pathname: string,
	payloadBytes: number,
	chunkSize = 64 * 1024,
): Request {
	let sent = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= payloadBytes) {
				controller.close();
				return;
			}
			const size = Math.min(chunkSize, payloadBytes - sent);
			controller.enqueue(new Uint8Array(size));
			sent += size;
		},
	});
	return new Request(`https://wine.test${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: stream,
		duplex: "half",
	} as RequestInit);
}

async function errorBody(res: Response): Promise<{ error?: string }> {
	return (await res.json()) as { error?: string };
}

describe("resolveBodyLimit", () => {
	it("既定は 10MB", () => {
		expect(DEFAULT_MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
		expect(resolveBodyLimit("/api/auth/sign-in")).toBe(DEFAULT_MAX_BODY_BYTES);
		expect(resolveBodyLimit("/_serverFn/quiz.saveAnswer")).toBe(
			DEFAULT_MAX_BODY_BYTES,
		);
		expect(resolveBodyLimit("/")).toBe(DEFAULT_MAX_BODY_BYTES);
	});

	it("/api/mcp は photo_base64 を考慮した個別上限", () => {
		// base64 の zod 上限 7_100_000 + エンベロープの余白。既定より小さいと
		// 最大長の正当な呼び出しが境界で落ちる。
		expect(MCP_MAX_BODY_BYTES).toBeGreaterThan(7_100_000);
		expect(resolveBodyLimit("/api/mcp")).toBe(MCP_MAX_BODY_BYTES);
	});

	it("フォーム系は対象外(独自上限を持つため)", () => {
		for (const path of [
			"/api/upload",
			"/api/wine-photos",
			"/api/import-batch-photos",
			"/api/label-analysis-jobs",
		]) {
			expect(resolveBodyLimit(path)).toBeNull();
		}
	});
});

describe("enforceBodyLimit", () => {
	it("content-length が上限を超えたらボディを読まずに 413", async () => {
		const res = await enforceBodyLimit(
			new Request("https://wine.test/api/auth/sign-in", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
				},
				body: JSON.stringify({ email: "a@example.com" }),
			}),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(413);
		expect((await errorBody(res)).error).toBe(BODY_TOO_LARGE_MESSAGE);
	});

	it("申告が無くても実バイト数が上限を超えたら 413", async () => {
		const res = await enforceBodyLimit(
			streamedRequest(
				"/api/auth/sign-in",
				DEFAULT_MAX_BODY_BYTES + 1024 * 1024,
			),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(413);
		expect((await errorBody(res)).error).toBe(BODY_TOO_LARGE_MESSAGE);
	});

	it("上限を超えた本文は最後まで読まない(メモリに載せない)", async () => {
		let produced = 0;
		const chunkSize = 64 * 1024;
		const huge = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced >= 100 * 1024 * 1024) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(chunkSize));
				produced += chunkSize;
			},
		});
		const res = await enforceBodyLimit(
			new Request("https://wine.test/_serverFn/quiz.saveAnswer", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: huge,
				duplex: "half",
			} as RequestInit),
		);
		expect(res).toBeInstanceOf(Response);
		if (res instanceof Response) expect(res.status).toBe(413);
		// 打ち切りの検知は上限超過時点で起きるので多少の行き過ぎは許容する。
		// 100MB を読み切っていないこと(=桁で違うこと)が要点。
		expect(produced).toBeLessThan(DEFAULT_MAX_BODY_BYTES * 2);
	});

	it("上限内の通常リクエストは本文を保って通す", async () => {
		const payload = JSON.stringify({ email: "a@example.com", password: "x" });
		const out = await enforceBodyLimit(
			new Request("https://wine.test/api/auth/sign-in", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: payload,
			}),
		);
		expect(out).toBeInstanceOf(Request);
		if (!(out instanceof Request)) return;
		expect(await out.json()).toEqual(JSON.parse(payload));
	});

	it("上限ちょうどは通す(境界)", async () => {
		const out = await enforceBodyLimit(
			streamedRequest("/api/auth/sign-in", DEFAULT_MAX_BODY_BYTES),
		);
		expect(out).toBeInstanceOf(Request);
	});

	it("MCP の個別上限は既定より大きい本文を通す", async () => {
		// 既定(10MB)を超え MCP 上限(12MB)以内の本文。
		const size = DEFAULT_MAX_BODY_BYTES + 1024 * 1024;
		expect(size).toBeLessThan(MCP_MAX_BODY_BYTES);
		const mcpOut = await enforceBodyLimit(streamedRequest("/api/mcp", size));
		expect(mcpOut).toBeInstanceOf(Request);
		const defaultOut = await enforceBodyLimit(
			streamedRequest("/api/auth/sign-in", size),
		);
		expect(defaultOut).toBeInstanceOf(Response);
		if (defaultOut instanceof Response) expect(defaultOut.status).toBe(413);
	});

	it("フォーム系は大きな申告でも通す(ルート側の上限に任せる)", async () => {
		const out = await enforceBodyLimit(
			new Request("https://wine.test/api/wine-photos", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
				},
				body: "x",
			}),
		);
		expect(out).toBeInstanceOf(Request);
	});

	it("GET は対象外", async () => {
		const out = await enforceBodyLimit(
			new Request("https://wine.test/api/auth/session"),
		);
		expect(out).toBeInstanceOf(Request);
	});
});
