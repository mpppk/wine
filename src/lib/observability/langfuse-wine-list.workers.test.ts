import { env } from "cloudflare:workers";
import { createTraceId } from "@langfuse/tracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_FEATURE_GENERATION_PREFIXES } from "#/lib/ai/inference-log";
import {
	resolveWineListPlan,
	runWineListAnalysisForJob,
} from "#/lib/services/ai-service";
import { beginMeteredInference } from "#/lib/services/metered-inference";
import { __resetLangfuseForTests } from "./langfuse";

// 一括抽出(wine_list_analysis)の Langfuse 計装を workerd 上で検証する(#515)。
// これで3機能(region_qa / label_analysis / wine_list_analysis)すべてが
// trace + generation を出ることがテストで固定される。

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";

/** data URI 1枚ぶんのダミー。JPEG ヘッダを持たせて photo-redact が寸法を読めるようにする。 */
function jpegDataUrl(width = 1600, height = 1200): string {
	const bytes = [
		0xff,
		0xd8,
		0xff,
		0xc0,
		0,
		11,
		8,
		(height >>> 8) & 0xff,
		height & 0xff,
		(width >>> 8) & 0xff,
		width & 0xff,
		3,
		1,
		0x22,
		0,
		2,
		0x11,
		1,
		3,
		0x11,
	];
	return `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
}
const PHOTO = jpegDataUrl();

function setLangfuseKeys(
	publicKey: string | undefined,
	secretKey: string | undefined,
) {
	const e = env as unknown as Record<string, string | undefined>;
	if (publicKey === undefined) delete e.LANGFUSE_PUBLIC_KEY;
	else e.LANGFUSE_PUBLIC_KEY = publicKey;
	if (secretKey === undefined) delete e.LANGFUSE_SECRET_KEY;
	else e.LANGFUSE_SECRET_KEY = secretKey;
}

type FetchCall = { url: string; body: string };

function bodyToString(body: unknown): string {
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (typeof body === "string") return body;
	try {
		return String(body);
	} catch {
		return "";
	}
}

function isLangfuseCall(c: FetchCall): boolean {
	return (
		c.url.includes("langfuse") || c.url.includes("/api/public/otel/v1/traces")
	);
}

function parseOtlpSpans(body: string): Array<Record<string, unknown>> {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	const spans: Array<Record<string, unknown>> = [];
	for (const rs of (parsed.resourceSpans ?? []) as Array<
		Record<string, unknown>
	>) {
		for (const ss of (rs.scopeSpans ?? []) as Array<Record<string, unknown>>) {
			spans.push(...((ss.spans ?? []) as Array<Record<string, unknown>>));
		}
	}
	return spans;
}

function spansOfCalls(calls: FetchCall[]): Array<Record<string, unknown>> {
	return calls.filter(isLangfuseCall).flatMap((c) => parseOtlpSpans(c.body));
}

function attrsOf(span: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		(
			(span.attributes ?? []) as Array<{
				key: string;
				value: { stringValue?: string };
			}>
		).map((a) => [a.key, a.value.stringValue ?? ""]),
	);
}

/** 銘柄1件ぶんの JSON(省略項目は null / 空配列)。 */
function wineJson(partial: Record<string, unknown>): Record<string, unknown> {
	return {
		wine_name: null,
		producer: null,
		vintage: null,
		appellation: null,
		region: null,
		grape_varieties: [],
		price: null,
		photo_indexes: [],
		...partial,
	};
}

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "wine-list-langfuse-user", `${id}@example.test`)
		.run();
	return id;
}

/**
 * OpenAI Responses API の成功応答(structured outputs の message アイテム)。
 * 一括抽出の GPT 経路は生の Responses API を使う。**reasoning の encrypted_content
 * も返してくる**実態に合わせた形にして、サニタイズで落ちることを確かめる。
 */
function openaiResponse(fields: Record<string, unknown>): Response {
	return Response.json({
		id: "resp_test",
		object: "response",
		created_at: 0,
		model: "gpt-5.6-luna",
		status: "completed",
		error: null,
		incomplete_details: null,
		output: [
			{
				type: "reasoning",
				id: "rs_test",
				content: [],
				encrypted_content: "gAAAAABsuperlongencryptedblob",
			},
			{
				type: "message",
				id: "msg_test",
				role: "assistant",
				status: "completed",
				content: [
					{ type: "output_text", text: JSON.stringify(fields), annotations: [] },
				],
			},
		],
		usage: { input_tokens: 3000, output_tokens: 500 },
	});
}

/** Anthropic Messages API の応答(stop_reason を差し替えられる)。 */
function anthropicMessage(
	fields: Record<string, unknown>,
	stopReason = "end_turn",
): Response {
	return Response.json({
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "claude-opus-5",
		stop_reason: stopReason,
		stop_sequence: null,
		content: [{ type: "text", text: JSON.stringify(fields) }],
		usage: { input_tokens: 1000, output_tokens: 200 },
	});
}

describe("一括抽出の Langfuse 計装 (#515)", () => {
	let calls: FetchCall[] = [];

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
		delete (env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
		delete (env as unknown as { AI?: unknown }).AI;
		setLangfuseKeys(undefined, undefined);
		__resetLangfuseForTests();
	});

	it("GPT経路がgenerationを報告し、写真インベントリがメタデータに載る", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		(env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
		stubAiRunRejecting();
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (isLangfuseCall({ url, body: "" })) {
					calls.push({ url, body: bodyToString(init?.body) });
					return new Response("{}", { status: 200 });
				}
				if (url.includes("openai.com")) {
					return openaiResponse({
						wines: [wineJson({ wine_name: "Chablis" })],
						truncated: false,
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			},
		);

		const userId = await seedUser();
		const plan = await resolveWineListPlan(userId, 1);
		const begun = await beginMeteredInference(userId, {
			estimate: plan.estimate,
			requestId: plan.requestId,
			logBase: plan.logBase,
		});
		if (begun.blocked) throw new Error("unreachable");
		const done = await runWineListAnalysisForJob(userId, {
			imageDataUrls: [PHOTO],
			plan,
			reservation: begun.reservation,
		});
		expect(done.value.summary.subject).toBe("wine_list");
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 50));

		const spans = spansOfCalls(calls);
		const expectedTraceId = await createTraceId(plan.requestId);
		// 全スパンが同一の決定的 traceId を共有する
		expect(new Set(spans.map((s) => String(s.traceId ?? s.trace_id)))).toEqual(
			new Set([expectedTraceId]),
		);
		// generation は網羅表の接頭辞で始まる名前を持つ
		const prefix = AI_FEATURE_GENERATION_PREFIXES.wine_list_analysis;
		const gen = spans.find((s) =>
			String(s.name).startsWith(`${prefix}gpt-luna#`),
		);
		expect(gen).toBeDefined();
		if (!gen) throw new Error("unreachable");
		// 写真インベントリがメタデータに載り、本体(base64/data URI)はどこにも現れない
		const attrs = attrsOf(gen);
		const photosJson = attrs["langfuse.observation.metadata.photos"];
		if (!photosJson) throw new Error("photos metadata missing");
		const photos = JSON.parse(photosJson) as Array<{
			mime: string;
			width: number;
			height: number;
		}>;
		expect(photos[0]).toMatchObject({
			mime: "image/jpeg",
			width: 1600,
			height: 1200,
		});
		const allBodies = calls
			.filter(isLangfuseCall)
			.map((c) => c.body)
			.join("\n");
		expect(allBodies).not.toContain("data:image/jpeg;base64");
		// reasoning の暗号化ブロック(encrypted_content)はサニタイズで落ちる
		expect(allBodies).not.toContain("gAAAAAB");
		// 本文(message の output_text)は残る
		expect(allBodies).toContain("output_text");
	});

	it("Claude経路はpause_turn継続ごとにgenerationを出す", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		(env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY =
			"sk-ant-test";
		let call = 0;
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (isLangfuseCall({ url, body: "" })) {
					calls.push({ url, body: bodyToString(init?.body) });
					return new Response("{}", { status: 200 });
				}
				if (url.includes("anthropic.com")) {
					call += 1;
					// 1回目は pause_turn(ツール実行中の中断)、2回目で本文を出す
					return call === 1
						? anthropicMessage({}, "pause_turn")
						: anthropicMessage({
								wines: [wineJson({ wine_name: "Chablis" })],
								truncated: false,
							});
				}
				throw new Error(`unexpected fetch: ${url}`);
			},
		);

		const userId = await seedUser();
		const plan = await resolveWineListPlan(userId, 1);
		const begun = await beginMeteredInference(userId, {
			estimate: plan.estimate,
			requestId: plan.requestId,
			logBase: plan.logBase,
		});
		if (begun.blocked) throw new Error("unreachable");
		await runWineListAnalysisForJob(userId, {
			imageDataUrls: [PHOTO],
			plan,
			reservation: begun.reservation,
		});
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 50));

		const spans = spansOfCalls(calls);
		const prefix = AI_FEATURE_GENERATION_PREFIXES.wine_list_analysis;
		const gens = spans.filter((s) => String(s.name).startsWith(prefix));
		const names = gens.map((s) => String(s.name)).sort();
		expect(names).toEqual([
			`${prefix}web-research#1`,
			`${prefix}web-research#2`,
		]);
		// 継続2件とも同じ traceId
		const expectedTraceId = await createTraceId(plan.requestId);
		for (const g of gens) {
			expect(String(g.traceId ?? g.trace_id)).toBe(expectedTraceId);
		}
	});

	function stubAiRunRejecting(): void {
		// 一括抽出は Workers AI へ降格しない(#358)。触れたら失敗として検出される。
		(env as unknown as { AI: { run: () => Promise<unknown> } }).AI = {
			run: () => Promise.reject(new Error("Workers AI must not be called")),
		};
	}
});
