#!/usr/bin/env node
// Cloudflare Workers Traces(Workers Observability)を CLI から検索する。
//
// ログの `bun run logs` と同じ理由で要る: ダッシュボードに入れない環境
// (Claude Code on the web / CI など)からトレースを見る手段が他に無い。叩く先も
// ログと同じ Observability のクエリ API で、`view` が `events` か `traces` かだけが違う。
//
// **ログとトレースの使い分け**: ログは「その時点で何が起きたか」の点の記録で、トレースは
// 「1リクエストの中で何がどの順にどれだけ掛かったか」の構造。`bun run logs` で失敗の
// メッセージを見つけ、同じ時刻・同じ操作のトレースをここで見て、どの D1 クエリ・どの
// 外部 fetch・どの推論が原因かまで降りる、という使い方をする。
//
// 【重要な制約】ログと同じく、PRごとのプレビューURL(`<branch>-wine-preview.*` /
// `<commit>-wine-preview.*`)へのアクセスは**トレースにも残らない**。Preview URLs の
// 制約は Workers Logs・`wrangler tail`・Logpush と同じくトレースにも掛かる。
// `--env preview` で見えるのはデプロイ済み `wine-preview`(main ミラー)への分のみ。
//
// 前提: wrangler.jsonc の `observability.traces.enabled: true` と、
//       `CLOUDFLARE_API_TOKEN`(Workers Observability の Read 権限を含むこと)。
//       **設定を入れたデプロイより前のリクエストにはトレースが無い**(遡れない)。
//
// 使い方:
//   bun run traces                            # 本番(wine)の直近1時間
//   bun run traces --env preview --since 3h   # プレビュー(wine-preview)の直近3時間
//   bun run traces --grep ai_inference        # スパン名の部分一致(カスタムスパン)
//   bun run traces --version <version-id>     # 特定の worker バージョンに限定
//   bun run traces --json                     # 生JSON(jq で加工する場合)
//
// API リファレンス:
//   https://developers.cloudflare.com/api/resources/workers/subresources/observability/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	callApi,
	parseSince,
	resolveAccountId,
	workerNameFromConfig,
} from "./logs.mjs";

const API_BASE = "https://api.cloudflare.com/client/v4";
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * トレース(スパン)のデータセット。**ログの `cloudflare-workers` とは別**(#506)。
 *
 * ここを間違えると **API は 200 と 0件を返す**。データセット名は検証されないため、
 * 「データセット指定が違う」と「その期間にトラフィックが無い」が区別できない
 * ——#505 のCLIはログと同じ `cloudflare-workers` を渡していて、トレースは正しく
 * 記録されているのに常に0件だった。空配列(=全データセット)でも引けるが、明示して
 * おかないと同じ取り違えを次にやる。
 */
const DATASETS = ["otel"];

const USAGE = `使い方: bun run traces [オプション]

  --env <production|preview>  対象環境(既定: production)。wrangler.jsonc の worker 名を引く
                              ※ preview は「デプロイ済みの wine-preview」(main ミラー)。
                                 PRごとのプレビューURLのトレースは Cloudflare 側の制約で取得できない
  --worker <name>             worker 名を直接指定(--env より優先)
  --since <30m|2h|3d>         遡る期間(既定: 1h)
  --limit <n>                 最大取得件数(既定: 20)
  --grep <text>               スパン名の部分一致で絞る(例: ai_inference / label_job / mcp_tool)
  --trace <trace-id>          そのトレースのスパンを親子付きで表示する(属性も出す)
  --version <version-id>      特定の worker バージョンに限定
  --json                      整形せず生JSONを出力する
  -h, --help                  このヘルプ

  カスタムスパン(src/lib/observability/span.ts):
    ai_inference  AI推論1回(予約〜確定/返却)。wine.ai.* 属性が付く
    label_job     エチケット解析ジョブ1件。wine.job.* 属性が付く
    mcp_tool      MCPツール実行1回。wine.mcp.tool 属性が付く
`;

/** argv を解釈する。未知のオプションは例外にする(打ち間違いを黙って無視しない)。 */
export function parseArgs(argv) {
	const opts = {
		env: "production",
		worker: null,
		since: "1h",
		limit: 20,
		grep: null,
		trace: null,
		version: null,
		json: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${arg} に値がありません`);
			return v;
		};
		switch (arg) {
			case "--env":
				opts.env = value();
				break;
			case "--worker":
				opts.worker = value();
				break;
			case "--since":
				opts.since = value();
				break;
			case "--limit":
				opts.limit = Number(value());
				break;
			case "--grep":
				opts.grep = value();
				break;
			case "--trace":
				opts.trace = value();
				break;
			case "--version":
				opts.version = value();
				break;
			case "--json":
				opts.json = true;
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			default:
				throw new Error(`不明なオプション: ${arg}\n\n${USAGE}`);
		}
	}
	if (!["production", "preview"].includes(opts.env)) {
		throw new Error(
			`--env は production か preview を指定してください: "${opts.env}"`,
		);
	}
	if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
		throw new Error(`--limit は正の数を指定してください: "${opts.limit}"`);
	}
	// parseSince をここで一度通し、API を叩く前に書式ミスを弾く
	parseSince(opts.since);
	return opts;
}

/** トレース検索のクエリ parameters を組み立てる(`view: "traces"` と併せて使う)。 */
export function buildParameters({ worker, grep, version }) {
	const filters = [
		{
			key: "$metadata.service",
			operation: "eq",
			value: worker,
			type: "string",
		},
	];
	if (grep) {
		filters.push({
			key: "$metadata.spanName",
			operation: "includes",
			value: grep,
			type: "string",
		});
	}
	if (version) {
		filters.push({
			key: "$workers.scriptVersion.id",
			operation: "eq",
			value: version,
			type: "string",
		});
	}
	return { datasets: DATASETS, filters };
}

/**
 * 1トレースのスパンを引く parameters(`view: "events"` と併せて使う)。
 *
 * トレース一覧は「1リクエスト = 1行」で、その中のどの操作が遅かったかは持たない。
 * スパン単位の行はこちらで引く——`otel` データセットでは1イベント = 1スパンになる。
 */
export function buildSpanParameters({ traceId }) {
	return {
		datasets: DATASETS,
		filters: [
			{
				key: "$metadata.traceId",
				operation: "eq",
				value: traceId,
				type: "string",
			},
		],
	};
}

function formatDuration(ms) {
	return ms === undefined || ms === null ? "" : ` ${Math.round(ms)}ms`;
}

function formatTime(timestamp) {
	if (timestamp === undefined || timestamp === null) return "-".padEnd(24);
	return `${new Date(timestamp).toISOString().replace("T", " ").slice(0, 23)}Z`;
}

/**
 * 1トレースを1行に整形する。
 *
 * `spans` は**スパン数**(数値)で、スパンの配列ではない。中身に降りるには `--trace`
 * (= `buildSpanParameters`)を使う。想定外の形なら加工せず生JSONを出す——整形に失敗して
 * 空行を出すより、読める形で全部見せるほうが調査の役に立つ。
 */
export function formatTrace(trace) {
	if (trace?.traceId === undefined) return JSON.stringify(trace);
	const errors = Array.isArray(trace.errors) ? trace.errors : [];
	// rootTransactionName は "POST https://…/api/mcp" で、rootSpanName("POST")を含む。
	// 一覧で欲しいのは経路が分かる前者。
	const name = trace.rootTransactionName ?? trace.rootSpanName ?? "-";
	return (
		`${formatTime(trace.traceStartMs)} ${name}` +
		`${formatDuration(trace.traceDurationMs)}` +
		` spans=${trace.spans ?? "?"} trace=${trace.traceId}` +
		(errors.length > 0 ? ` ERR=${JSON.stringify(errors)}` : "")
	);
}

/**
 * カスタムスパンの属性を `wine.mcp.tool=list_aops` の形に平坦化する。
 *
 * スパンの属性は行の `source` 直下にドット区切りのオブジェクトとして入る
 * (`source.wine.mcp.tool`)。プラットフォーム側の属性(`cloudflare.*` / `faas.*` 等)は
 * 量が多く調査の役に立たないので、**このアプリが付けた `wine.*` だけを出す**。
 */
export function formatSpanAttributes(source) {
	const out = [];
	const walk = (value, prefix) => {
		if (value === null || typeof value !== "object") {
			out.push(`${prefix}=${value}`);
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			walk(child, `${prefix}.${key}`);
		}
	};
	if (source?.wine !== undefined) walk(source.wine, "wine");
	return out.join(" ");
}

/**
 * 1トレースのスパンを親子の入れ子で整形する。
 *
 * 深さは `parentSpanId` から辿る。**自動計装のスパン(D1・外向きfetch)とカスタムスパンが
 * 同じ木に並ぶ**のが要点で、「MCPツールの中で走った2本のD1クエリのどちらが遅いか」は
 * この形でしか読めない。
 */
export function formatSpanTree(rows) {
	const spans = rows
		.map((row) => row?.source)
		.filter((s) => s?.spanId !== undefined);
	const children = new Map();
	for (const span of spans) {
		const key = span.parentSpanId ?? "__root__";
		children.set(key, [...(children.get(key) ?? []), span]);
	}
	// 親がこのトレースに無いスパン(取得件数で切れた場合)も根として拾う。取り違えて
	// 「1件も出ない」より、親が欠けたまま出すほうがよい。
	const ids = new Set(spans.map((s) => s.spanId));
	const roots = [
		...(children.get("__root__") ?? []),
		...spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId)),
	];
	const lines = [];
	const emit = (span, depth) => {
		const attrs = formatSpanAttributes(span);
		lines.push(
			`${"  ".repeat(depth + 1)}${span.name ?? "-"}` +
				`${formatDuration(span.durationMS)}${attrs ? `  ${attrs}` : ""}`,
		);
		for (const child of (children.get(span.spanId) ?? []).sort(
			(a, b) => (a.startTime ?? 0) - (b.startTime ?? 0),
		)) {
			emit(child, depth + 1);
		}
	};
	for (const root of roots.sort(
		(a, b) => (a.startTime ?? 0) - (b.startTime ?? 0),
	)) {
		emit(root, 0);
	}
	return lines.join("\n");
}

async function main(argv) {
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (e) {
		console.error(e.message);
		return 1;
	}
	if (opts.help) {
		console.log(USAGE);
		return 0;
	}

	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) {
		console.error(
			"CLOUDFLARE_API_TOKEN が未設定です。Workers Observability の Read 権限を含む\n" +
				"API トークンを発行して環境変数に設定してください。",
		);
		return 1;
	}

	const worker =
		opts.worker ??
		workerNameFromConfig(
			fs.readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8"),
			opts.env,
		);

	const accountId = await resolveAccountId(token);
	const to = Date.now();
	const from = to - parseSince(opts.since) * 1000;
	const queryUrl = `${API_BASE}/accounts/${accountId}/workers/observability/telemetry/query`;

	// --trace: 1トレースのスパンを親子で出す(一覧ではなくこちらを出して終わる)
	if (opts.trace) {
		const spanResult = await callApi(queryUrl, token, {
			method: "POST",
			body: JSON.stringify({
				queryId: "wine-trace-spans-cli",
				// 1トレースのスパンは通常数十件。取り漏らすと木が欠けるので一覧より多く取る
				limit: 200,
				view: "events",
				timeframe: { from, to },
				parameters: buildSpanParameters({ traceId: opts.trace }),
			}),
		});
		const rows = spanResult?.events?.events ?? [];
		if (opts.json) {
			console.log(JSON.stringify(rows, null, 2));
			return 0;
		}
		console.log(`# trace ${opts.trace} / ${rows.length}スパン`);
		if (rows.length === 0) {
			console.log(
				"\nスパンがありません。trace ID が正しいか、--since の期間に入っているかを\n" +
					"確認してください(既定は直近1時間)。",
			);
			return 0;
		}
		console.log(formatSpanTree(rows));
		return 0;
	}

	const result = await callApi(queryUrl, token, {
		method: "POST",
		body: JSON.stringify({
			queryId: "wine-traces-cli",
			limit: opts.limit,
			view: "traces",
			timeframe: { from, to },
			parameters: buildParameters({
				worker,
				grep: opts.grep,
				version: opts.version,
			}),
		}),
	});

	const traces = result?.traces ?? [];
	if (opts.json) {
		console.log(JSON.stringify(traces, null, 2));
		return 0;
	}

	console.log(
		`# ${worker} / 直近${opts.since} / ${traces.length}件` +
			(opts.grep ? ` / grep=${opts.grep}` : "") +
			(opts.version ? ` / version=${opts.version}` : ""),
	);
	for (const trace of traces) console.log(formatTrace(trace));
	if (traces.length > 0) {
		console.log(
			"\n個々のスパン(D1クエリ・カスタムスパン)に降りるには:" +
				` bun run traces --trace ${traces[0].traceId}`,
		);
	}

	if (traces.length === 0) {
		console.log(
			"\nトレースがありません。次を確認してください:\n" +
				"  - `observability.traces.enabled: true` を含むデプロイが済んでいるか\n" +
				"    (設定より前のリクエストには遡れない)\n" +
				`  - 対象期間(--since ${opts.since})にその環境へのアクセスがあったか\n` +
				"  - PRごとのプレビューURL(<branch>-wine-preview.*)へのアクセスは、Cloudflare の\n" +
				"    制約でトレースに出ない。--env preview で見えるのはデプロイ済み\n" +
				"    https://wine-preview.niboshi.workers.dev への分のみ\n" +
				"  - Workers Observability の保持期間(最大7日)を過ぎていないか",
		);
	}
	return 0;
}

// スクリプトとして直接実行された時のみ走らせる(import 時は純関数だけ使える)
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
}
