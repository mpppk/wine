/**
 * エチケット解析の高精度経路(`gpt-luna`)を**本番と同じモジュール**で実機実行し、
 * 抽出結果・usage の内訳・検索の軌跡を目視で確かめるスクリプト。
 *
 * この経路の原価は 入力 / 出力 / キャッシュ読み / **web検索の回数** に分かれており、
 * 合計トークンからは復元できない。過去に壊れたのは換算式ではなく「プロバイダは
 * 返しているのにマッパーが拾っていない」という欠落で(#355)、その形の欠落は
 * typecheck も単体テストも検出しない。単体テスト側のガード
 * (usage-accounting.test.ts)と対になる**実応答での確認**がここ。
 *
 * リクエストの組み立て・usage の変換・軌跡の抽出は `ai-service.ts` の
 * `analyzeLabelWithGptResearch` と同じ関数を通すので、ここが正しければ本番経路も
 * 同じ値を出す(差分はクレジット台帳への記録だけ)。**`ai` / `@ai-sdk/openai` を
 * 上げたときはこれを1回流して内訳が欠けていないか見る**(#455 の実測時は
 * `usage.raw` が空で、正規化後の形が唯一の情報源だった)。
 *
 * 使い方:
 *   OPENAI_API_KEY=... bun scripts/spike-label-usage.ts <画像パス...>
 *
 * プロキシ環境下で bun の fetch が外へ出られない場合は tsx で代替する:
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/spike-label-usage.ts <画像パス...>
 *
 * **実際に課金が発生する**(1回あたり数十クレジット相当)。CI からは実行しない。
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import {
	accumulateStepUsage,
	countProviderExecutedCalls,
	toAiSdkUsage,
} from "#/lib/ai/ai-sdk-usage";
import {
	AI_LABEL_AGENT_BUDGET_RATIO,
	AI_LABEL_AGENT_MAX_STEPS,
	AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
	AI_LABEL_GPT_MODEL,
	AI_LABEL_GPT_REASONING_EFFORT,
	AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
	estimateLabelReserveCharge,
} from "#/lib/ai/config";
import { buildLabelSuggestions } from "#/lib/ai/label-extraction";
import {
	assertGptLabelFinished,
	buildGptLabelMessages,
	GPT_WEB_SEARCH_TOOL_NAME,
} from "#/lib/ai/label-gpt-research";
import {
	type AnswerCollector,
	buildLabelTools,
	ZOOM_OUTPUT_MAX_DIMENSION,
} from "#/lib/ai/label-tools";
import {
	extractAiSdkWebSearchTrace,
	type WebResearchTrace,
} from "#/lib/ai/web-research-trace";
import {
	type AiUsage,
	MICRO_USD_PER_CREDIT,
	toCharge,
	usageToMicroUsd,
} from "#/lib/billing/ai-pricing";
import { resolveCropBox, resolveOutputWidth } from "#/lib/images/crop-geometry";

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

/**
 * PIL で切り出す(このスクリプト専用。本番は Cloudflare Images バインディング)。
 * 幾何は本番と同じ `resolveCropBox` / `resolveOutputWidth` を通す。
 */
async function cropWithPil(
	path: string,
	box: { x: number; y: number; width: number; height: number },
): Promise<{ dataUrl: string; applied: typeof box }> {
	const size = JSON.parse(
		execFileSync("python3", [
			"-c",
			`from PIL import Image;im=Image.open(${JSON.stringify(path)});import json;print(json.dumps({"width":im.size[0],"height":im.size[1]}))`,
		]).toString(),
	) as { width: number; height: number };
	const resolved = resolveCropBox(box, size);
	const { left, top, width, height } = resolved.pixels;
	const outWidth = resolveOutputWidth(
		resolved.pixels,
		ZOOM_OUTPUT_MAX_DIMENSION,
	);
	const out = join(tmpdir(), `crop-${Date.now()}.jpg`);
	execFileSync("python3", [
		"-c",
		[
			"from PIL import Image",
			`im=Image.open(${JSON.stringify(path)}).crop((${left},${top},${left + width},${top + height}))`,
			outWidth === undefined
				? ""
				: `im=im.resize((${outWidth}, max(1, round(im.size[1]*${outWidth}/im.size[0]))))`,
			`im.save(${JSON.stringify(out)}, quality=90)`,
		]
			.filter(Boolean)
			.join("\n"),
	]);
	const buf = await readFile(out);
	await writeFile(out, buf);
	return {
		dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
		applied: resolved.applied,
	};
}

function creditsOf(usage: AiUsage): number {
	return toCharge(AI_LABEL_GPT_MODEL, usage).microUsd / MICRO_USD_PER_CREDIT;
}

async function main(): Promise<void> {
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) throw new Error("OPENAI_API_KEY が未設定です");

	const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	if (paths.length === 0) throw new Error("画像パスを1つ以上指定してください");

	const imageDataUrls = await Promise.all(paths.map(toDataUrl));
	console.log(`写真 ${imageDataUrls.length} 枚 / モデル ${AI_LABEL_GPT_MODEL}`);

	// 本番と同じ組み立て。軌跡はステップ完了ごとに積む(検証器が引用の裏取りに使う)。
	const openai = createOpenAI({ apiKey });
	const contentParts: unknown[] = [];
	let trace: WebResearchTrace | undefined;
	const collector: AnswerCollector = {};
	const usageOptions = {
		billCacheWrites: false,
		webSearchToolName: GPT_WEB_SEARCH_TOOL_NAME,
		webSearches: 0,
	};
	// 予算は本番と同じ式で出す(予約見積 × 比率)。
	const budgetMicroUsd =
		estimateLabelReserveCharge("gpt-luna", imageDataUrls.length).microUsd *
		AI_LABEL_AGENT_BUDGET_RATIO;
	const startedAt = Date.now();
	const result = await generateText({
		model: openai(AI_LABEL_GPT_MODEL),
		messages: buildGptLabelMessages(imageDataUrls),
		tools: {
			[GPT_WEB_SEARCH_TOOL_NAME]: openai.tools.webSearch({
				searchContextSize: AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
			}),
			...buildLabelTools({
				collector,
				getVerifyContext: () => ({ trace }),
				photoCount: imageDataUrls.length,
				// 本番は env.IMAGES で切るが、このスクリプトは Node で動くので PIL に委ねる。
				// **幾何(どこを切るか)は本番と同じ resolveCropBox を通す**ので、
				// 検証したい部分は共通のまま。
				cropPhoto: async (photoIndex, box) =>
					cropWithPil(paths[photoIndex] as string, box),
			}),
		},
		stopWhen: [
			() => collector.accepted !== undefined,
			({ steps }) =>
				usageToMicroUsd(
					AI_LABEL_GPT_MODEL,
					accumulateStepUsage(steps, usageOptions),
				) >= budgetMicroUsd,
			stepCountIs(AI_LABEL_AGENT_MAX_STEPS),
		],
		maxOutputTokens: AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
		providerOptions: {
			openai: { reasoningEffort: AI_LABEL_GPT_REASONING_EFFORT },
		},
		// 本番と揃える(workerd では未処理の Promise 拒否を残すため切ってある)
		telemetry: { isEnabled: false },
		// 本番と同じ: ツール実行の前に軌跡を積む(検証器が引用の裏取りに使うため)
		onLanguageModelCallEnd: ({ content }) => {
			contentParts.push(...content);
			trace = extractAiSdkWebSearchTrace(contentParts);
		},
	});
	const elapsedMs = Date.now() - startedAt;
	assertGptLabelFinished(result.finishReason);

	const usage = toAiSdkUsage(result.usage, {
		webSearches: countProviderExecutedCalls(
			result.toolCalls,
			GPT_WEB_SEARCH_TOOL_NAME,
		),
		billCacheWrites: false,
	});
	const answer = collector.accepted ?? collector.last;
	if (!answer) throw new Error("エージェントループが回答を提出しませんでした");
	const extraction = answer.extraction;

	console.log("\n================ usage の内訳 ================");
	console.table([
		{
			入力: usage.inputTokens ?? 0,
			出力: usage.outputTokens ?? 0,
			キャッシュ読: usage.cacheReadTokens ?? 0,
			web検索回数: usage.webSearches ?? 0,
			クレジット: Math.round(creditsOf(usage) * 10) / 10,
			所要秒: Math.round(elapsedMs / 100) / 10,
		},
	]);
	// 正規化前の内訳も出す。SDK 更新で項目が欠けたときに、マッパーの問題か
	// SDK が返していないのかをここで切り分ける。
	console.log("SDK usage:", JSON.stringify(result.usage, null, 2));
	console.log("finishReason:", result.finishReason);
	console.log(
		"steps:",
		result.steps.length,
		"/ 上限",
		AI_LABEL_AGENT_MAX_STEPS,
	);
	console.log("verified:", answer.verified);
	console.log(
		"予算(µUSD):",
		Math.round(budgetMicroUsd),
		"/ 予約見積:",
		estimateLabelReserveCharge("gpt-luna", imageDataUrls.length).microUsd,
	);
	console.log(
		"使ったツール:",
		JSON.stringify(
			result.toolCalls.map((c) =>
				c?.toolName === "zoom_photo"
					? { tool: c.toolName, input: c.input }
					: c?.toolName,
			),
		),
	);

	console.log("\n================ 抽出結果 ================");
	console.log("extraction:", JSON.stringify(extraction, null, 2));
	console.log(
		"suggestions:",
		JSON.stringify(buildLabelSuggestions(extraction), null, 2),
	);
	console.log("fieldSources:", JSON.stringify(answer.fieldSources, null, 2));
	console.log("trace:", JSON.stringify(trace, null, 2));
}

await main();
