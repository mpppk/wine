import { env } from "cloudflare:workers";
import { createTraceId } from "@langfuse/tracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import {
	resolveLabelPlan,
	runLabelAnalysisForJob,
} from "#/lib/services/ai-service";
import { beginMeteredInference } from "#/lib/services/metered-inference";
import { __resetLangfuseForTests } from "./langfuse";

// エチケット解析の Langfuse 計装を workerd 上で検証する(#514)。
// 主眼は**フォールバックの可視化**: 高精度経路が失敗して Workers AI へ降格した回に、
// 「降格前の generation(失敗側経路の応答)」と「降格先の generation(成功)」が
// **同じ trace に並ぶ**こと。実行記録の route と executedBy の食い違い(fellBack)は
// 間接的な証拠でしかなく、「降格前のモデルが実際に何を返していたか」は Langfuse だけが残す。
//
// 併せて、写真そのもの(data URI / base64)が OTLP のボディに一切現れないことも
// 固定する。mask フック(langfuse-mask.ts)の裏門に加え、入力を要約へ置き換える
// photo-redact の関門が効いていることの回帰防止。

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";

/**
 * data URI 1枚ぶんのダミー。**JPEG のヘッダだけは本物**にする——photo-redact が
 * 寸法を読む相手なので、SOI + SOF0 の形を持たせないと要約が作られない。
 */
function jpegDataUrl(width = 2180, height = 1200): string {
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

/** 捕まえた全呼び出しのスパンを連結する(exportMode: immediate は span ごとに fetch する)。 */
function spansOfCalls(calls: FetchCall[]): Array<Record<string, unknown>> {
	return calls.filter(isLangfuseCall).flatMap((c) => parseOtlpSpans(c.body));
}

async function seedPremiumUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "langfuse-label-user", `${id}@example.test`)
		.run();
	await db.insert(subscription).values({
		id: `sub-${id}`,
		plan: "premium",
		referenceId: id,
		status: "active",
	});
	return id;
}

function stubAiRun(run: () => Promise<unknown>): void {
	(env as unknown as { AI: { run: () => Promise<unknown> } }).AI = { run };
}

/**
 * OpenAI へ incomplete(status: incomplete = 出力枠の打ち切り)を返させ、Langfuse への
 * OTLP を捕まえる。incomplete は assertGptLabelFinished が失敗とみなして throw し、
 * Workers AI へフォールバックする——**モデル呼び出しそのものは完了している**ので、
 * onLanguageModelCallEnd での報告(onLanguageModelCallEnd を報告点にする理由)が
 * 潰れていないことをこの応答で確かめられる。
 */
function stubOpenAiIncompleteAndCapture(calls: FetchCall[]): void {
	(env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (isLangfuseCall({ url, body: "" })) {
				calls.push({ url, body: bodyToString(init?.body) });
				return new Response("{}", { status: 200 });
			}
			if (url.includes("openai.com")) {
				return Response.json({
					id: "resp_incomplete",
					object: "response",
					created_at: 0,
					model: "gpt-5.6-luna",
					status: "incomplete",
					error: null,
					incomplete_details: { reason: "max_output_tokens" },
					output: [],
					usage: { input_tokens: 4000, output_tokens: 16000 },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		},
	);
}

/**
 * OpenAI へ `submit_answer` で検証を通る回答を返させる(1呼び出しでループが収束する)。
 * generation の出力にツール呼び出しが載り、ツール実行の span が1本立つことを
 * 確かめるための応答。
 */
function stubOpenAiSubmitAndCapture(
	calls: FetchCall[],
	answer: Record<string, unknown>,
): void {
	(env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (isLangfuseCall({ url, body: "" })) {
				calls.push({ url, body: bodyToString(init?.body) });
				return new Response("{}", { status: 200 });
			}
			if (url.includes("openai.com")) {
				return Response.json({
					id: "resp_submit",
					object: "response",
					created_at: 0,
					model: "gpt-5.6-luna",
					status: "completed",
					error: null,
					incomplete_details: null,
					output: [
						{
							type: "function_call",
							id: "fc_test",
							call_id: "call_test",
							name: "submit_answer",
							arguments: JSON.stringify(answer),
							status: "completed",
						},
					],
					usage: { input_tokens: 1200, output_tokens: 300 },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		},
	);
}

describe("エチケット解析の Langfuse 計装 (#514)", () => {
	let calls: FetchCall[] = [];

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
		delete (env as unknown as { AI?: unknown }).AI;
		setLangfuseKeys(undefined, undefined);
		__resetLangfuseForTests();
	});

	it("フォールバックした回に高精度経路のgenerationとWorkers AIのgenerationが同じtraceに並ぶ", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stubOpenAiIncompleteAndCapture(calls);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: null,
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 55 },
		}));
		const userId = await seedPremiumUser();

		const plan = await resolveLabelPlan(userId, 1);
		const begun = await beginMeteredInference(userId, {
			estimate: plan.estimate,
			requestId: plan.requestId,
			logBase: plan.logBase,
		});
		expect(begun.blocked).toBe(false);
		if (begun.blocked) return;
		const done = await runLabelAnalysisForJob(userId, {
			imageDataUrls: [PHOTO],
			plan,
			reservation: begun.reservation,
		});
		// Workers AI が拾って解析自体は完了する
		expect(done.value.name).toBe("Chablis");

		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 50));

		const otlp = calls.filter(isLangfuseCall);
		expect(otlp.length).toBeGreaterThanOrEqual(2);
		const spans = otlp.flatMap((c) => parseOtlpSpans(c.body));
		// 同一 requestId から決定的に導出された traceId を**全スパンが共有する**
		const expectedTraceId = await createTraceId(plan.requestId);
		const traceIds = new Set(spans.map((s) => String(s.traceId ?? s.trace_id)));
		expect(traceIds).toEqual(new Set([expectedTraceId]));

		// 降格前(GPT)と降格先(Workers AI)の両方の generation が同じ trace にある
		const names = spans.map((s) => String(s.name));
		const gptGen = spans.find((s) =>
			String(s.name).startsWith("label_analysis:gpt-luna#"),
		);
		const workersAiGen = spans.find((s) =>
			String(s.name).startsWith("label_analysis:workers-ai#photo"),
		);
		expect(gptGen, `spans were: ${names.join(", ")}`).toBeDefined();
		expect(workersAiGen).toBeDefined();
		expect(String(gptGen!.traceId)).toBe(expectedTraceId);
		expect(String(workersAiGen!.traceId)).toBe(expectedTraceId);

		// どちらも root(ai:label_analysis)の直下
		const root = spans.find((s) => s.name === "ai:label_analysis");
		expect(root).toBeDefined();
		const rootSpanId = String(root!.spanId ?? root!.span_id);
		for (const gen of [gptGen!, workersAiGen!]) {
			expect(String(gen.parentSpanId ?? gen.parent_span_id)).toBe(rootSpanId);
		}
	});

	it("写真のdata URIはOTLPボディに現れず、要約(MIME・寸法・ハッシュ)だけが載る", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		// Workers AI 単独の経路(キー未設定 = 高精度経路は解決段階で外れる)。
		// Langfuse への送信だけを捕まえる。
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (
					url.includes("langfuse") ||
					url.includes("/api/public/otel/v1/traces")
				) {
					calls.push({ url, body: bodyToString(init?.body) });
					return new Response("{}", { status: 200 });
				}
				throw new Error(`unexpected fetch: ${url}`);
			},
		);
		stubAiRun(async () => ({
			response: JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: null,
				appellation: null,
				region: null,
				grape_varieties: [],
			}),
			usage: { total_tokens: 55 },
		}));
		const userId = await seedPremiumUser();

		const plan = await resolveLabelPlan(userId, 1);
		const begun = await beginMeteredInference(userId, {
			estimate: plan.estimate,
			requestId: plan.requestId,
			logBase: plan.logBase,
		});
		if (begun.blocked) throw new Error("unreachable");
		await runLabelAnalysisForJob(userId, {
			imageDataUrls: [PHOTO],
			plan,
			reservation: begun.reservation,
		});
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 50));

		const allBodies = calls
			.filter(isLangfuseCall)
			.map((c) => c.body)
			.join("\n");
		// 写真そのもの(base64 ペイロード・data URI)はどこにも現れない
		expect(allBodies).not.toContain(PHOTO.slice(0, 40));
		expect(allBodies).not.toContain("data:image/jpeg;base64");
		// 代わりに要約が載る。**メタデータは入力テキストと別の属性**なので、
		// 長いプロンプト(LABEL_PROMPT は既知呼称リストを含み mask の上限を超える)が
		// 切り詰められてもインベントリは生きる。ここが写真インベントリの生存証明になる。
		const gen = spansOfCalls(calls).find((s) =>
			String(s.name).startsWith("label_analysis:workers-ai#photo"),
		);
		expect(gen).toBeDefined();
		const attrs = Object.fromEntries(
			(
				(gen!.attributes ?? []) as Array<{
					key: string;
					value: { stringValue?: string };
				}>
			).map((a) => [a.key, a.value.stringValue ?? ""]),
		);
		const photos = JSON.parse(
			attrs["langfuse.observation.metadata.photos"]!,
		) as Array<{
			mime: string;
			width?: number;
			height?: number;
			approxBytes: number;
			sha256: string;
		}>;
		expect(photos).toHaveLength(1);
		expect(photos[0]).toMatchObject({
			mime: "image/jpeg",
			width: 2180,
			height: 1200,
		});
		expect(photos[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("エージェントループのステップとツール実行(submit_answer)がspanとして立つ", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stubOpenAiSubmitAndCapture(calls, {
			wine_name: "Chablis",
			producer: null,
			vintage: null,
			appellation: "Chablis",
			region: null,
			grape_varieties: [],
			sources: {},
		});
		stubAiRun(() => Promise.reject(new Error("Workers AI must not be called")));
		const userId = await seedPremiumUser();

		const plan = await resolveLabelPlan(userId, 1);
		const begun = await beginMeteredInference(userId, {
			estimate: plan.estimate,
			requestId: plan.requestId,
			logBase: plan.logBase,
		});
		if (begun.blocked) throw new Error("unreachable");
		const done = await runLabelAnalysisForJob(userId, {
			imageDataUrls: [PHOTO],
			plan,
			reservation: begun.reservation,
		});
		expect(done.value.name).toBe("Chablis");
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 50));

		const spans = spansOfCalls(calls);
		const names = spans.map((s) => String(s.name));
		// モデル呼び出し1回 = generation 1件
		expect(
			names.filter((n) => n.startsWith("label_analysis:gpt-luna#")),
		).toHaveLength(1);
		// ツール実行は span になる。出力に検証の結果(accepted)が載る
		const submit = spans.find((s) => s.name === "submit_answer");
		expect(submit, `spans were: ${names.join(", ")}`).toBeDefined();
		const attrs = Object.fromEntries(
			(
				(submit!.attributes ?? []) as Array<{
					key: string;
					value: { stringValue?: string };
				}>
			).map((a) => [a.key, a.value.stringValue ?? ""]),
		);
		expect(attrs["langfuse.observation.output"]).toContain('"accepted":true');
	});
});
