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
import { __resetLangfusePromptForTests } from "./langfuse-prompt";

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
/**
 * Langfuse 管理下のプロンプト取得は 404 で落とす(IMPL-3 W3-2)。
 * ai-service は推論の実行直前に `getManagedPrompt` で本文を引くが、計装テストの
 * 焦点は OTLP の generation / span にある。SDK が fallback 本文へ倒すので、
 * プロンプト未登録の環境と同じ挙動になる。
 */
function isPromptFetch(url: string): boolean {
	return url.includes("/api/public/v2/prompts/");
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
 * OpenRouter chat completion の成功応答(本文テキスト)。
 */
function orChatResponse(fields: Record<string, unknown>): Response {
	return Response.json({
		choices: [
			{
				finish_reason: "stop",
				message: { content: JSON.stringify(fields) },
			},
		],
		usage: { prompt_tokens: 3000, completion_tokens: 500 },
	});
}

/** スタブ・鍵・isolate 内 singleton を元に戻す(各 describe の afterEach)。 */
function resetStubs() {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
	setLangfuseKeys(undefined, undefined);
	__resetLangfuseForTests();
	__resetLangfusePromptForTests();
}

describe("一括抽出の Langfuse 計装 (#515)", () => {
	let calls: FetchCall[] = [];

	beforeEach(() => {
		calls = [];
	});

	afterEach(resetStubs);

	it("GPT経路がgenerationを報告し、写真インベントリがメタデータに載る", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
			"or-test";
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (isPromptFetch(url)) {
					return new Response("{}", { status: 404 });
				}
				if (isLangfuseCall({ url, body: "" })) {
					calls.push({ url, body: bodyToString(init?.body) });
					return new Response("{}", { status: 200 });
				}
				if (url.startsWith("https://openrouter.ai/api/v1/")) {
					return orChatResponse({
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
		// 本文(JSONテキスト)は残る
		expect(allBodies).toContain("Chablis");
	});

	it("Claude経路は1リクエストでgenerationを出す", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
			"or-test";
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (isPromptFetch(url)) {
					return new Response("{}", { status: 404 });
				}
				if (isLangfuseCall({ url, body: "" })) {
					calls.push({ url, body: bodyToString(init?.body) });
					return new Response("{}", { status: 200 });
				}
				if (url.startsWith("https://openrouter.ai/api/v1/")) {
					return orChatResponse({
						wines: [wineJson({ wine_name: "Chablis" })],
						truncated: false,
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			},
		);

		const userId = await seedUser();
		await env.DB.prepare(
			"UPDATE user SET preferred_label_engine = 'web-research' WHERE id = ?",
		)
			.bind(userId)
			.run();
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
		// サーバーツールは OpenRouter 側で完結するので、generation は1件だけ
		const names = gens.map((s) => String(s.name)).sort();
		expect(names).toEqual([`${prefix}web-research#1`]);
		// 同じ traceId
		const expectedTraceId = await createTraceId(plan.requestId);
		for (const g of gens) {
			expect(String(g.traceId ?? g.trace_id)).toBe(expectedTraceId);
		}
	});
});

describe("銘柄の位置の推定(Jev の Box。#693)", () => {
	let calls: FetchCall[] = [];
	let decisionBodies: Array<Record<string, unknown>> = [];

	beforeEach(() => {
		calls = [];
		decisionBodies = [];
	});

	afterEach(resetStubs);

	const BOX = { top: 0.1, bottom: 0.3, left: 0.2, right: 0.5 };

	/** 抽出(chat)と位置(decisions)の応答を差し替える。decisions の応答は引数で決める。 */
	function stubOpenRouter(
		extraction: Record<string, unknown>,
		decisions: (body: Record<string, unknown>) => Response,
	) {
		(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
			"or-test";
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (isPromptFetch(url)) return new Response("{}", { status: 404 });
				if (isLangfuseCall({ url, body: "" })) {
					calls.push({ url, body: bodyToString(init?.body) });
					return new Response("{}", { status: 200 });
				}
				if (url === "https://openrouter.ai/api/alpha/decisions") {
					const body = JSON.parse(bodyToString(init?.body)) as Record<
						string,
						unknown
					>;
					decisionBodies.push(body);
					return decisions(body);
				}
				if (url.startsWith("https://openrouter.ai/api/v1/")) {
					return orChatResponse(extraction);
				}
				throw new Error(`unexpected fetch: ${url}`);
			},
		);
	}

	async function runJob(photoCount: number) {
		const userId = await seedUser();
		const plan = await resolveWineListPlan(userId, photoCount);
		const begun = await beginMeteredInference(userId, {
			estimate: plan.estimate,
			requestId: plan.requestId,
			logBase: plan.logBase,
		});
		if (begun.blocked) throw new Error("unreachable");
		return runWineListAnalysisForJob(userId, {
			imageDataUrls: Array.from({ length: photoCount }, () => PHOTO),
			plan,
			reservation: begun.reservation,
		});
	}

	it("写真ごとに Box と Noul を問い、写っている銘柄にだけ枠を付けて Jev の原価も計上する", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stubOpenRouter(
			{
				subject: "wine_list",
				wines: [
					wineJson({ wine_name: "Chablis", photo_indexes: [0] }),
					wineJson({ wine_name: "Meursault", photo_indexes: [0, 1] }),
				],
				truncated: false,
			},
			(body) => {
				const questions = body.questions as Record<
					string,
					{ instructions: string }
				>;
				// 写真0: Chablis(b0) は写っている、Meursault(b1) は写っていない
				// 写真1: Meursault(b0) は写っている
				const meursaultFirst = questions.b0?.instructions.includes("Meursault");
				return Response.json({
					model: "typesafe/jev-1.14-20261014",
					answers: meursaultFirst
						? {
								b0: { type: "box", box: BOX, confidence: 0.9 },
								p0: { noul: 0.95 },
							}
						: {
								b0: { type: "box", box: BOX, confidence: 0.95 },
								p0: { noul: 0.99 },
								b1: { type: "box", box: BOX, confidence: 0.2 },
								p1: { noul: 0.05 },
							},
					usage: { input_tokens: 200_000, output_tokens: 10 },
				});
			},
		);

		const done = await runJob(2);
		await new Promise((r) => setTimeout(r, 50));

		// 写真2枚 = 2リクエスト。画像は data URI のまま state に載る
		expect(decisionBodies).toHaveLength(2);
		expect(decisionBodies[0]?.model).toBe("typesafe/jev-1.14");
		const [chablis, meursault] = done.value.candidates;
		expect(chablis?.photoBoxes).toEqual([{ photoIndex: 0, box: BOX }]);
		expect(meursault?.photoBoxes).toEqual([{ photoIndex: 1, box: BOX }]);

		// Jev の入力(200k × 2 = 400k tok × $0.042/MTok = 16,800 µUSD)が確定額に乗る
		expect(done.charge.microUsd).toBeGreaterThanOrEqual(16_800);

		// generation として Langfuse へ報告し、写真の実体は載せない
		const prefix = AI_FEATURE_GENERATION_PREFIXES.wine_list_analysis;
		const names = spansOfCalls(calls).map((s) => String(s.name));
		expect(names).toContain(`${prefix}locate#1`);
		expect(names).toContain(`${prefix}locate#2`);
		const allBodies = calls
			.filter(isLangfuseCall)
			.map((c) => c.body)
			.join("\n");
		expect(allBodies).not.toContain("data:image/jpeg;base64");
	});

	it("Jev が失敗しても抽出結果は返す(枠なし)", async () => {
		stubOpenRouter(
			{
				subject: "wine_list",
				wines: [wineJson({ wine_name: "Chablis", photo_indexes: [0] })],
				truncated: false,
			},
			() => Response.json({ error: { message: "down" } }, { status: 503 }),
		);
		const done = await runJob(1);
		expect(decisionBodies).toHaveLength(1);
		expect(done.value.candidates[0]?.suggestions.name).toBe("Chablis");
		expect(done.value.candidates[0]?.photoBoxes).toBeUndefined();
	});

	it("1本のワインと判定された回は問い合わせない(単体の登録へ案内され枠を使わない)", async () => {
		stubOpenRouter(
			{
				subject: "single_wine",
				wines: [wineJson({ wine_name: "Chablis", photo_indexes: [0] })],
				truncated: false,
			},
			() => {
				throw new Error("must not be called");
			},
		);
		const done = await runJob(1);
		expect(decisionBodies).toHaveLength(0);
		expect(done.value.summary.subject).toBe("single_wine");
	});
});
