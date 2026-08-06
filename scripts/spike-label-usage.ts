/**
 * 検証用スパイク: エチケット解析の高精度経路(`gpt-luna`)を
 *
 *   A) 現行実装(openai SDK を直叩き。`ai-service.ts` の analyzeLabelWithGptResearch と同形)
 *   B) Vercel AI SDK 経由(`ai` + `@ai-sdk/openai`)
 *
 * で**同一の写真**に対して実行し、抽出結果と **usage の内訳**を突き合わせる。
 *
 * 目的は精度比較ではなく**会計の忠実度**の確認(#355 / #404 の教訓)。この経路の原価は
 * 入力/出力/キャッシュ読み/**web検索の回数**に分かれており、合計トークンからは復元
 * できない。AI SDK は usage をプロバイダ横断の共通形へ正規化するので、
 *
 *   - 非キャッシュ入力・キャッシュ読みの内訳が保たれるか
 *   - **web検索の実行回数が数えられるか**(Luna の原価の大半。usage には出ない)
 *   - 検索の軌跡(何を検索し何を開いたか)が取れるか
 *
 * を実測で確かめる。ここが取れないなら AI SDK への移行は見送る。
 *
 * 使い方:
 *   OPENAI_API_KEY=... bun scripts/spike-label-usage.ts <画像パス...> [--only=current|aisdk]
 *
 * プロキシ環境下で bun の fetch が外へ出られない場合は tsx で代替する:
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/spike-label-usage.ts <画像パス...>
 *
 * **実際に課金が発生する**(1回あたり数十クレジット相当)。CI からは実行しない。
 */

import { readFile } from "node:fs/promises";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, Output } from "ai";
import OpenAI from "openai";
import {
	AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
	AI_LABEL_GPT_MODEL,
	AI_LABEL_GPT_REASONING_EFFORT,
	AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
} from "#/lib/ai/config";
import {
	buildLabelSuggestions,
	buildWebLabelPrompt,
	extractJsonPayload,
	LABEL_WEB_JSON_SCHEMA,
	type LabelExtraction,
	type LabelFieldSources,
	parseLabelResponse,
	parseLabelSources,
} from "#/lib/ai/label-extraction";
import {
	buildGptLabelInput,
	buildGptLabelTextFormat,
	countGptWebSearches,
	extractGptLabelText,
	toGptUsage,
} from "#/lib/ai/label-gpt-research";
import {
	extractGptTrace,
	type WebResearchTrace,
} from "#/lib/ai/web-research-trace";
import {
	type AiUsage,
	MICRO_USD_PER_CREDIT,
	toCharge,
} from "#/lib/billing/ai-pricing";

interface RunResult {
	label: string;
	usage: AiUsage;
	extraction: LabelExtraction;
	fieldSources?: LabelFieldSources;
	trace?: WebResearchTrace;
	/** プロバイダが返した生の usage(内訳が保たれているかの照合用)。 */
	rawUsage: unknown;
	elapsedMs: number;
}

const MEDIA_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
};

async function toDataUrl(path: string): Promise<string> {
	const ext = path.split(".").pop()?.toLowerCase() ?? "jpg";
	const mediaType = MEDIA_TYPES[ext] ?? "image/jpeg";
	const buf = await readFile(path);
	return `data:${mediaType};base64,${buf.toString("base64")}`;
}

/** A) 現行実装。`analyzeLabelWithGptResearch` と同じ引数・同じ後処理を通す。 */
async function runCurrent(
	apiKey: string,
	imageDataUrls: string[],
): Promise<RunResult> {
	const client = new OpenAI({ apiKey });
	const startedAt = Date.now();
	const response = await client.responses.create({
		model: AI_LABEL_GPT_MODEL,
		input: buildGptLabelInput(imageDataUrls),
		max_output_tokens: AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
		reasoning: { effort: AI_LABEL_GPT_REASONING_EFFORT },
		tools: [
			{
				type: "web_search",
				search_context_size: AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
			},
		],
		include: ["web_search_call.action.sources"],
		text: buildGptLabelTextFormat(),
	});
	const elapsedMs = Date.now() - startedAt;
	const usage = toGptUsage(
		response.usage,
		countGptWebSearches(response.output),
	);
	const trace = extractGptTrace(response.output);
	const payload = extractJsonPayload(extractGptLabelText(response));
	return {
		label: "A) 現行 (openai SDK)",
		usage,
		extraction: parseLabelResponse(payload),
		fieldSources: parseLabelSources(payload),
		trace,
		rawUsage: response.usage,
		elapsedMs,
	};
}

/**
 * B) AI SDK 経由。**プロンプト・スキーマ・上限値・reasoning effort・検索コンテキストは
 * 現行と同じ値**を渡し、差分が SDK の層だけになるようにする。
 */
async function runAiSdk(
	apiKey: string,
	imageDataUrls: string[],
): Promise<RunResult> {
	const openai = createOpenAI({ apiKey });
	const startedAt = Date.now();
	const result = await generateText({
		model: openai(AI_LABEL_GPT_MODEL),
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: buildWebLabelPrompt() },
					// data URI をそのまま file パートで渡す(v7 で image パートは非推奨)。
					...imageDataUrls.map((url) => ({
						type: "file" as const,
						data: url,
						mediaType: url.slice(5, url.indexOf(";")),
					})),
				],
			},
		],
		tools: {
			web_search: openai.tools.webSearch({
				searchContextSize: AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
			}),
		},
		output: Output.object({
			schema: jsonSchema<Record<string, unknown>>(
				LABEL_WEB_JSON_SCHEMA as unknown as Record<string, unknown>,
			),
		}),
		maxOutputTokens: AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
		providerOptions: {
			openai: {
				reasoningEffort: AI_LABEL_GPT_REASONING_EFFORT,
				// 現行は include: ["web_search_call.action.sources"] で検索結果のURLを
				// 取り寄せている(付けないと「何を見たか」が落ちる)。provider が受け付ける
				// のは .results 系のみなので、軌跡が復元できるかをここで確かめる。
				include: ["web_search_call.results"],
			},
		},
	});
	const elapsedMs = Date.now() - startedAt;

	// web検索はプロバイダ実行ツール。**回数は usage に出ない**ので、現行が output 配列を
	// 数えているのと同じことを toolCalls 側で行えるかがこの検証の核心。
	const webSearches = result.toolCalls.filter(
		(c) => c.toolName === "web_search",
	).length;
	const u = result.usage;
	const usage: AiUsage = {
		// 現行(toGptUsage)は input から cached を引いて非キャッシュ入力にしている。
		// AI SDK は inputTokenDetails.noCacheTokens として最初から分けて返す。
		inputTokens:
			u.inputTokenDetails.noCacheTokens ??
			Math.max(
				0,
				(u.inputTokens ?? 0) - (u.inputTokenDetails.cacheReadTokens ?? 0),
			),
		outputTokens: u.outputTokens ?? 0,
		cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
		webSearches,
	};

	const payload = result.output as Record<string, unknown>;
	return {
		label: "B) AI SDK",
		usage,
		extraction: parseLabelResponse(payload),
		fieldSources: parseLabelSources(payload),
		// 軌跡は provider 固有の形で来るはず。取れるかどうかも観測対象なので生で残す。
		trace: undefined,
		rawUsage: {
			normalized: u,
			raw: u.raw,
			sources: result.sources,
			stepCount: result.steps.length,
			toolCalls: result.toolCalls,
			toolResults: result.toolResults,
		},
		elapsedMs,
	};
}

function creditsOf(usage: AiUsage): number {
	return toCharge(AI_LABEL_GPT_MODEL, usage).microUsd / MICRO_USD_PER_CREDIT;
}

function report(runs: RunResult[]): void {
	console.log("\n================ usage の内訳 ================");
	const rows = runs.map((r) => ({
		経路: r.label,
		入力: r.usage.inputTokens ?? 0,
		出力: r.usage.outputTokens ?? 0,
		キャッシュ読: r.usage.cacheReadTokens ?? 0,
		web検索回数: r.usage.webSearches ?? 0,
		クレジット: Math.round(creditsOf(r.usage) * 10) / 10,
		所要秒: Math.round(r.elapsedMs / 100) / 10,
	}));
	console.table(rows);

	console.log("\n================ 抽出結果 ================");
	for (const r of runs) {
		console.log(`\n--- ${r.label}`);
		console.log("extraction:", JSON.stringify(r.extraction, null, 2));
		console.log(
			"suggestions:",
			JSON.stringify(buildLabelSuggestions(r.extraction), null, 2),
		);
		console.log("fieldSources:", JSON.stringify(r.fieldSources, null, 2));
		console.log("trace:", JSON.stringify(r.trace, null, 2));
		console.log("rawUsage:", JSON.stringify(r.rawUsage, null, 2));
	}
}

async function main(): Promise<void> {
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) throw new Error("OPENAI_API_KEY が未設定です");

	const args = process.argv.slice(2);
	const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];
	const paths = args.filter((a) => !a.startsWith("--"));
	if (paths.length === 0) throw new Error("画像パスを1つ以上指定してください");

	const imageDataUrls = await Promise.all(paths.map(toDataUrl));
	console.log(`写真 ${imageDataUrls.length} 枚 / モデル ${AI_LABEL_GPT_MODEL}`);

	const runs: RunResult[] = [];
	if (only !== "aisdk") runs.push(await runCurrent(apiKey, imageDataUrls));
	if (only !== "current") runs.push(await runAiSdk(apiKey, imageDataUrls));
	report(runs);
}

await main();
