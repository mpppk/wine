import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REGION_QA_SYSTEM_PROMPT } from "#/lib/ai/managed-prompts";
import { MICRO_USD_PER_CREDIT } from "#/lib/billing/ai-pricing";
import { runMeteredInference } from "#/lib/services/metered-inference";
import { __resetLangfuseForTests } from "./langfuse";
import {
	__resetLangfusePromptForTests,
	getManagedPrompt,
	resolvePromptLabel,
} from "./langfuse-prompt";

// Langfuse のプロンプト管理を workerd 上で検証する(#512 Phase 4)。
//
// 本文のSSOTが Langfuse へ移ったので、見るのは「取れた版が使われるか」だけでなく
// **「壊れた版・取れなかったときにコードの fallback へ落ちるか」**の方が重い。
// CI がプロンプトの網でなくなったぶんを、この実行時ガードが受け持つ。

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";
const PROMPT_PATH = `/api/public/v2/prompts/${encodeURIComponent(REGION_QA_SYSTEM_PROMPT.name)}`;
const REGION_CONTEXT = "ブルゴーニュ / 石灰質";

function setLangfuseKeys(publicKey?: string, secretKey?: string) {
	const e = env as unknown as Record<string, string | undefined>;
	if (publicKey === undefined) delete e.LANGFUSE_PUBLIC_KEY;
	else e.LANGFUSE_PUBLIC_KEY = publicKey;
	if (secretKey === undefined) delete e.LANGFUSE_SECRET_KEY;
	else e.LANGFUSE_SECRET_KEY = secretKey;
}

function textPromptBody(prompt: string, version = 7) {
	return JSON.stringify({
		name: REGION_QA_SYSTEM_PROMPT.name,
		version,
		type: "text",
		prompt,
		labels: ["preview"],
		tags: [],
		config: {},
	});
}

type PromptStub = { status: number; body: string };

/** OTLP exporter は Uint8Array で body を渡すので文字列へ戻す。 */
function bodyToString(body: unknown): string {
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer)
		return new TextDecoder().decode(new Uint8Array(body));
	if (typeof body === "string") return body;
	return String(body);
}

describe("langfuse prompt management", () => {
	let promptCalls: string[] = [];
	let otlpCalls: string[] = [];
	let stub: PromptStub = { status: 200, body: textPromptBody("") };

	beforeEach(() => {
		promptCalls = [];
		otlpCalls = [];
		__resetLangfusePromptForTests();
		__resetLangfuseForTests();
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes(PROMPT_PATH)) {
					promptCalls.push(url);
					return new Response(stub.body, {
						status: stub.status,
						headers: { "content-type": "application/json" },
					});
				}
				if (url.includes("/api/public/otel/v1/traces")) {
					otlpCalls.push(bodyToString(init?.body ?? ""));
					return new Response("{}", { status: 200 });
				}
				return new Response("{}", { status: 200 });
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		setLangfuseKeys(undefined, undefined);
		__resetLangfusePromptForTests();
		__resetLangfuseForTests();
	});

	it("キー未設定ならプロンプトを取りに行かず、コードの fallback を使う", async () => {
		setLangfuseKeys(undefined, undefined);
		const result = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
			region_context: REGION_CONTEXT,
		});
		expect(promptCalls).toHaveLength(0);
		expect(result.source).toBe("code-no-keys");
		expect(result.ref).toBeNull();
		expect(result.text).toContain(REGION_CONTEXT);
		expect(result.text).not.toContain("{{");
	});

	it("取得できた版を使い、版へのリンクを返す", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stub = {
			status: 200,
			body: textPromptBody("Langfuse 版の指示文\n{{region_context}}", 7),
		};
		const result = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
			region_context: REGION_CONTEXT,
		});
		expect(promptCalls).toHaveLength(1);
		// 環境で引くラベルが決まる(本番だけ production)。
		expect(promptCalls[0]).toContain(`label=${resolvePromptLabel()}`);
		expect(result.source).toBe("langfuse");
		expect(result.ref).toEqual({
			name: REGION_QA_SYSTEM_PROMPT.name,
			version: 7,
			isFallback: false,
		});
		expect(result.text).toBe(`Langfuse 版の指示文\n${REGION_CONTEXT}`);
	});

	it("取得に失敗してもコードの fallback で回答を組み立てられる", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stub = { status: 500, body: "boom" };
		const result = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
			region_context: REGION_CONTEXT,
		});
		expect(result.source).toBe("code-fetch-failed");
		expect(result.ref).toBeNull();
		expect(result.text).toContain("事実を創作しない");
		expect(result.text).toContain(REGION_CONTEXT);
	});

	it("必須変数を消された版は使わない(グラウンディングの黙った消滅を防ぐ)", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stub = { status: 200, body: textPromptBody("地域情報を持たない指示文", 8) };
		const result = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
			region_context: REGION_CONTEXT,
		});
		expect(result.source).toBe("code-invalid-template");
		expect(result.ref).toBeNull();
		expect(result.text).toContain(REGION_CONTEXT);
	});

	it("コードが渡さない変数を足された版は使わない(空文字に畳まれるのを防ぐ)", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stub = {
			status: 200,
			body: textPromptBody("{{tone}} で答える\n{{region_context}}", 9),
		};
		const result = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
			region_context: REGION_CONTEXT,
		});
		expect(result.source).toBe("code-invalid-template");
		expect(result.ref).toBeNull();
		expect(result.text).not.toContain("で答える");
	});

	it("generation の OTLP 属性に版が載る", async () => {
		setLangfuseKeys(PUBLIC_KEY, SECRET_KEY);
		stub = {
			status: 200,
			body: textPromptBody("Langfuse 版\n{{region_context}}", 7),
		};
		const managed = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
			region_context: REGION_CONTEXT,
		});
		expect(managed.ref).not.toBeNull();

		const userId = crypto.randomUUID();
		await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
			.bind(userId, "prompt-user", `${userId}@example.test`)
			.run();
		const estimate = { microUsd: MICRO_USD_PER_CREDIT, tokens: 0 };
		await runMeteredInference(
			userId,
			{
				estimate,
				requestId: `ask_region:${crypto.randomUUID()}`,
				logBase: {
					feature: "region_qa",
					selected: "gemma4",
					route: "gemma4",
					model: "@cf/google/gemma-4",
				},
			},
			async (ctx) => {
				ctx.recordGeneration({
					name: "region_qa:@cf/google/gemma-4",
					model: "@cf/google/gemma-4",
					input: [{ role: "system", content: managed.text }],
					output: "bonjour",
					...(managed.ref ? { prompt: managed.ref } : {}),
					metadata: { promptSource: managed.source },
				});
				return { value: "ok", charge: estimate, usage: {} };
			},
		);
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 30));

		const body = otlpCalls.join("\n");
		expect(body).toContain("langfuse.observation.prompt.name");
		expect(body).toContain(REGION_QA_SYSTEM_PROMPT.name);
		expect(body).toContain("langfuse.observation.prompt.version");
		expect(body).toContain("promptSource");
	});
});
