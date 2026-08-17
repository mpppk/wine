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

const USAGE = `使い方: bun run traces [オプション]

  --env <production|preview>  対象環境(既定: production)。wrangler.jsonc の worker 名を引く
                              ※ preview は「デプロイ済みの wine-preview」(main ミラー)。
                                 PRごとのプレビューURLのトレースは Cloudflare 側の制約で取得できない
  --worker <name>             worker 名を直接指定(--env より優先)
  --since <30m|2h|3d>         遡る期間(既定: 1h)
  --limit <n>                 最大取得件数(既定: 20)
  --grep <text>               スパン名の部分一致で絞る(例: ai_inference / label_job / mcp_tool)
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

/**
 * トレース検索のクエリ parameters を組み立てる。データセットはログと同一で
 * (`cloudflare-workers`)、`view` の指定でトレースが返る。
 */
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
	return { datasets: ["cloudflare-workers"], filters };
}

function formatDuration(ms) {
	return ms === undefined || ms === null ? "" : ` ${Math.round(ms)}ms`;
}

function formatTime(timestamp) {
	if (timestamp === undefined || timestamp === null) return "-".padEnd(24);
	return `${new Date(timestamp).toISOString().replace("T", " ").slice(0, 23)}Z`;
}

/**
 * 1トレースを1行(+子スパンはインデント)に整形する。
 *
 * **キーの取り方に複数の候補を持たせてある**。ログの `events` と違い traces ビューの
 * 行の形は API ドキュメントに載っておらず、`$metadata` 側に来るか行の直下に来るかを
 * 実データで確認するまで確定できなかったため。想定外の形なら**加工せず生JSONを出す**
 * ——整形に失敗して空行を出すより、読める形で全部見せるほうが調査の役に立つ。
 * 生の値が要るときは `--json` を使う。
 */
export function formatTrace(trace) {
	const meta = trace?.$metadata ?? {};
	const traceId = meta.traceId ?? trace?.traceId;
	const name = meta.spanName ?? trace?.spanName ?? trace?.name;
	const duration =
		meta.traceDuration ?? trace?.traceDuration ?? trace?.duration;
	if (traceId === undefined && name === undefined) return JSON.stringify(trace);

	const head =
		`${formatTime(trace?.timestamp ?? meta.timestamp)} ` +
		`${name ?? "-"}${formatDuration(duration)}` +
		`${traceId ? ` trace=${traceId}` : ""}`;
	const spans = Array.isArray(trace?.spans) ? trace.spans : [];
	const lines = [head];
	for (const span of spans) {
		const spanMeta = span?.$metadata ?? {};
		const spanName = span?.name ?? spanMeta.spanName ?? "-";
		const spanDuration =
			span?.duration ?? span?.durationMs ?? spanMeta.traceDuration;
		lines.push(`  ${spanName}${formatDuration(spanDuration)}`);
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

	const result = await callApi(
		`${API_BASE}/accounts/${accountId}/workers/observability/telemetry/query`,
		token,
		{
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
		},
	);

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
