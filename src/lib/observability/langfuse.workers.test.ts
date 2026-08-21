import { env } from "cloudflare:workers";
import { createTraceId } from "@langfuse/tracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MICRO_USD_PER_CREDIT } from "#/lib/billing/ai-pricing";
import { runMeteredInference } from "#/lib/services/metered-inference";
import { __resetLangfuseForTests } from "./langfuse";

// Langfuse へ OTLP を出す配線を workerd 上で検証する(#512, #513)。
// 見るのは「1推論=1trace+1generationの入れ子」「traceId決定論的」「キー未設定で
// fetchしない」「送信失敗で例外漏れしない」「maskがdata URIを落とす」「Node組込の混入なし」。

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";

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

type FetchCall = {
	url: string;
	body: string;
	headers: Headers;
	auth: string | null;
};

function isLangfuseOtlpCall(c: FetchCall): boolean {
	return (
		c.url.includes("langfuse") || c.url.includes("/api/public/otel/v1/traces")
	);
}

function parseOtlpSpans(body: string): Array<Record<string, unknown>> {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	const resourceSpans = (parsed.resourceSpans ??
		parsed.resource_spans ??
		[]) as Array<Record<string, unknown>>;
	const spans: Array<Record<string, unknown>> = [];
	for (const rs of resourceSpans) {
		const scopeSpans = (rs.scopeSpans ?? rs.scope_spans ?? []) as Array<
			Record<string, unknown>
		>;
		for (const ss of scopeSpans) {
			const arr = (ss.spans ?? []) as Array<Record<string, unknown>>;
			spans.push(...arr);
		}
	}
	return spans;
}

function bodyToString(body: unknown): string {
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer)
		return new TextDecoder().decode(new Uint8Array(body));
	if (typeof body === "string") return body;
	// exporter may pass Blob/ReadableStream-like — fallback
	try {
		return String(body);
	} catch {
		return "";
	}
}

function dumpOtlpBody(body: string): string {
	try {
		return body.slice(0, 2000);
	} catch {
		return String(body).slice(0, 2000);
	}
}

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "langfuse-user", `${id}@example.test`)
		.run();
	return id;
}

const LOG_BASE = {
	feature: "region_qa",
	selected: "gemma4",
	route: "gemma4",
	model: "@cf/google/gemma-4",
} as const;

const ESTIMATE = { microUsd: MICRO_USD_PER_CREDIT, tokens: 0 };

describe("langfuse", () => {
	let calls: FetchCall[] = [];

	beforeEach(() => {
		calls = [];
		__resetLangfuseForTests();
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers as HeadersInit);
				const raw = init?.body as unknown;
				const body = raw ? bodyToString(raw) : "";
				// Basic認証ヘッダを拾う（OTLP exporter は Authorization: Basic ... を付ける）
				const auth =
					headers.get("Authorization") ?? headers.get("authorization");
				calls.push({ url, body, headers, auth });
				return new Response("{}", { status: 200 });
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		setLangfuseKeys(undefined, undefined);
		__resetLangfuseForTests();
	});

	it("キー未設定なら fetch しない", async () => {
		setLangfuseKeys(undefined, undefined);
		__resetLangfuseForTests();
		const userId = await seedUser();
		await runMeteredInference(
			userId,
			{
				estimate: ESTIMATE,
				requestId: `ask_region:${crypto.randomUUID()}`,
				logBase: LOG_BASE,
			},
			async (ctx) => {
				ctx.recordGeneration({
					name: "region_qa:gemma4",
					model: "@cf/google/gemma-4",
					input: [{ role: "user", content: "hello" }],
					output: "bonjour",
				});
				return { value: "ok", charge: ESTIMATE, usage: {} };
			},
		);
		// waitUntil 分を含むマイクロタスクを回してから観測
		await Promise.resolve();
		await Promise.resolve();
		expect(calls.filter(isLangfuseOtlpCall)).toHaveLength(0);
	});

	it("1推論=1 trace(root)+1 generation の入れ子になり、traceIdはrequestIdから決定的に導出される", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		__resetLangfuseForTests();
		const userId = await seedUser();
		const requestId = `ask_region:${crypto.randomUUID()}`;
		const expectedTraceId = await createTraceId(requestId);

		await runMeteredInference(
			userId,
			{ estimate: ESTIMATE, requestId, logBase: LOG_BASE },
			async (ctx) => {
				ctx.recordGeneration({
					name: "region_qa:gemma4",
					model: "@cf/google/gemma-4",
					input: [{ role: "user", content: "hello" }],
					output: "bonjour",
					usage: { totalTokens: 42 },
				});
				return { value: "ok", charge: ESTIMATE, usage: {} };
			},
		);
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 30));

		const otlp = calls.filter(isLangfuseOtlpCall);
		expect(otlp.length).toBeGreaterThanOrEqual(1);
		// exportMode: immediate は span ごとに fetch するため、全呼び出しを跨いで集計する
		const spans = otlp.flatMap((c) => parseOtlpSpans(c.body));
		// デバッグしやすいように失敗時のダンプを出す
		if (spans.length !== 2) {
			const dump = otlp.map((c) => dumpOtlpBody(c.body)).join("\n---\n");
			throw new Error(`expected 2 spans but got ${spans.length}: ${dump}`);
		}
		expect(spans).toHaveLength(2);

		// 両方の traceId が決定的な値に一致する
		for (const s of spans) {
			expect((s.traceId as string) ?? (s.trace_id as string)).toBe(
				expectedTraceId,
			);
		}

		// generation の parentSpanId が root の spanId と一致する
		const byName = Object.fromEntries(spans.map((s) => [String(s.name), s]));
		const root = byName["ai:region_qa"] as Record<string, unknown>;
		const gen = byName["region_qa:gemma4"] as Record<string, unknown>;
		expect(root).toBeDefined();
		expect(gen).toBeDefined();
		expect((gen.parentSpanId as string) ?? (gen.parent_span_id as string)).toBe(
			(root.spanId as string) ?? (root.span_id as string),
		);

		// generation の入出力が載っている（テキストは送る）
		const allBodies = otlp.map((c) => c.body).join("\n");
		expect(allBodies).toContain("hello");
		expect(allBodies).toContain("bonjour");
		// OTLP の送信先が JP リージョンである
		expect(otlp[0]!.url).toContain("jp.cloud.langfuse.com");
	});

	it("送信が失敗（例外/4xx）しても呼び出し側へ例外が漏れない", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		__resetLangfuseForTests();
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("langfuse") || url.includes("/api/public/otel")) {
					throw new Error("langfuse down");
				}
				// D1など他用途の fetch は通す（テスト基盤が使わない想定だが保険）
				const headers = new Headers(init?.headers as HeadersInit);
				calls.push({
					url,
					body: bodyToString(init?.body as unknown),
					headers,
					auth: headers.get("Authorization"),
				});
				return new Response("{}", { status: 200 });
			},
		);

		const userId = await seedUser();
		await expect(
			runMeteredInference(
				userId,
				{
					estimate: ESTIMATE,
					requestId: `ask_region:${crypto.randomUUID()}`,
					logBase: LOG_BASE,
				},
				async (ctx) => {
					ctx.recordGeneration({
						name: "region_qa:gemma4",
						model: "@cf/google/gemma-4",
						input: "hi",
						output: "hello",
					});
					return { value: "ok", charge: ESTIMATE, usage: {} };
				},
			),
		).resolves.toMatchObject({ blocked: false });

		// 4xx でも同様に落ちない
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("langfuse") || url.includes("/api/public/otel")) {
				return new Response("{}", { status: 500 });
			}
			return new Response("{}", { status: 200 });
		});
		await expect(
			runMeteredInference(
				userId,
				{
					estimate: ESTIMATE,
					requestId: `ask_region:${crypto.randomUUID()}`,
					logBase: LOG_BASE,
				},
				async (ctx) => {
					ctx.recordGeneration({
						name: "region_qa:gemma4",
						model: "@cf/google/gemma-4",
						input: "hi2",
						output: "hello2",
					});
					return { value: "ok2", charge: ESTIMATE, usage: {} };
				},
			),
		).resolves.toMatchObject({ blocked: false, value: "ok2" });
	});

	it("mask が data URI を落とす（OTLP ボディに data: が現れない）", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		__resetLangfuseForTests();
		calls = [];
		const userId = await seedUser();
		const dataUri = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEB";
		await runMeteredInference(
			userId,
			{
				estimate: ESTIMATE,
				requestId: `ask_region:${crypto.randomUUID()}`,
				logBase: LOG_BASE,
			},
			async (ctx) => {
				ctx.recordGeneration({
					name: "region_qa:gemma4",
					model: "@cf/google/gemma-4",
					input: `prefix ${dataUri} suffix`,
					output: "ok",
				});
				return { value: "ok", charge: ESTIMATE, usage: {} };
			},
		);
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 30));
		const otlp = calls.filter(isLangfuseOtlpCall);
		expect(otlp.length).toBeGreaterThanOrEqual(1);
		const allBodies = otlp.map((c) => c.body).join("\n");
		expect(allBodies).not.toContain("data:image");
		expect(allBodies).not.toContain("/9j/4AAQ");
		expect(allBodies).toContain("[data URI omitted]");
	});

	it("推論が失敗した回でも trace は閉じ、送信は試みられる", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		__resetLangfuseForTests();
		const userId = await seedUser();
		await expect(
			runMeteredInference(
				userId,
				{
					estimate: ESTIMATE,
					requestId: `ask_region:${crypto.randomUUID()}`,
					logBase: LOG_BASE,
				},
				async () => {
					throw new Error("inference failed");
				},
			),
		).rejects.toThrow("inference failed");
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 30));
		const otlp = calls.filter(isLangfuseOtlpCall);
		// 失敗時も root trace は閉じて送られる（generation は無いが trace 自体は存在）
		expect(otlp.length).toBeGreaterThanOrEqual(1);
		const spans = parseOtlpSpans(otlp[otlp.length - 1]!.body);
		expect(spans.length).toBeGreaterThanOrEqual(1);
	});
});
