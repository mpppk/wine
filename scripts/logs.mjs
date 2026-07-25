#!/usr/bin/env node
// Cloudflare Workers Logs(Workers Observability)を CLI から検索する。
//
// ダッシュボードに入れない環境(Claude Code on the web / CI など)から、本番 `wine` と
// デプロイ済みプレビュー `wine-preview` のランタイムログを後追いで調べるための入口。
// `wrangler tail` は「今まさに流れているログ」しか見えず再現操作と同時実行が必要なため、
// 後から追う用途はこちらでカバーする(Observability に蓄積済みのログを検索する)。
//
// 【重要な制約】PRごとのプレビューURL(`<branch>-wine-preview.*` / `<commit>-wine-preview.*`)
// へのアクセスはログに残らない。Cloudflare の Preview URLs の制約で、Workers Logs・
// `wrangler tail`・Logpush のいずれからも参照できない:
//   https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations
// `--env preview` で見えるのは、デプロイ済みバージョン(main のミラー、
// https://wine-preview.niboshi.workers.dev)へのアクセス分のみ。
// PR段階で実機ログが要る場合は、ローカル(`bun run dev`)で再現するか、マージ後に確認する。
//
// 前提: wrangler.jsonc の `observability.enabled: true`(本番/preview 双方に効く)と、
//       `CLOUDFLARE_API_TOKEN`(Workers Observability の Read 権限を含むこと)。
//
// 使い方:
//   bun run logs                             # 本番(wine)の直近1時間
//   bun run logs --env preview --since 3h    # プレビュー(wine-preview)の直近3時間
//   bun run logs --level error,warn          # エラー・警告のみ
//   bun run logs --grep stripe --since 1d    # message 部分一致
//   bun run logs --version <version-id>      # 特定バージョン(PRのプレビュー)に限定
//   bun run logs --json                      # 生JSON(jq で加工する場合)
//
// API リファレンス:
//   https://developers.cloudflare.com/api/resources/workers/subresources/observability/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LEVELS = ["debug", "info", "log", "warn", "error"];

const USAGE = `使い方: bun run logs [オプション]

  --env <production|preview>  対象環境(既定: production)。wrangler.jsonc の worker 名を引く
                              ※ preview は「デプロイ済みの wine-preview」(main ミラー)。
                                 PRごとのプレビューURLのログは Cloudflare 側の制約で取得できない
  --worker <name>             worker 名を直接指定(--env より優先)
  --since <30m|2h|3d>         遡る期間(既定: 1h)
  --limit <n>                 最大取得件数(既定: 50)
  --level <a,b,...>           ログレベルで絞る(${LEVELS.join(" / ")})
  --grep <text>               message の部分一致で絞る
  --version <version-id>      特定の worker バージョンに限定(PRのプレビュー等)
  --json                      整形せず生JSONを出力する
  -h, --help                  このヘルプ
`;

/** JSONC(コメント付きJSON)からコメントを除去する。文字列リテラル内の // や /* は温存する。 */
export function stripJsonComments(text) {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += c;
			// エスケープされた文字(\" や \\)は次の1文字ごと読み飛ばす
			if (c === "\\") {
				out += next ?? "";
				i++;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && next === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out;
}

/** `30m` / `2h` / `3d` / `90s` を秒数に変換する。 */
export function parseSince(input) {
	const m = /^(\d+)(s|m|h|d)$/.exec(String(input).trim());
	if (!m) {
		throw new Error(
			`--since の書式が不正です: "${input}" (例: 30m, 2h, 3d)`,
		);
	}
	const n = Number(m[1]);
	const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
	return n * unit;
}

/** argv を解釈する。未知のオプションは例外にする(打ち間違いを黙って無視しない)。 */
export function parseArgs(argv) {
	const opts = {
		env: "production",
		worker: null,
		since: "1h",
		limit: 50,
		levels: [],
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
			case "--level":
				opts.levels = value()
					.split(",")
					.map((s) => s.trim().toLowerCase())
					.filter((s) => s.length > 0);
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
		throw new Error(`--env は production か preview を指定してください: "${opts.env}"`);
	}
	if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
		throw new Error(`--limit は正の数を指定してください: "${opts.limit}"`);
	}
	for (const level of opts.levels) {
		if (!LEVELS.includes(level)) {
			throw new Error(
				`--level に未知の値があります: "${level}" (${LEVELS.join(" / ")})`,
			);
		}
	}
	// parseSince をここで一度通し、API を叩く前に書式ミスを弾く
	parseSince(opts.since);
	return opts;
}

/** wrangler.jsonc から対象環境の worker 名を引く(production は top-level の name)。 */
export function workerNameFromConfig(configText, env) {
	const config = JSON.parse(stripJsonComments(configText));
	if (env === "preview") {
		const name = config.env?.preview?.name;
		if (!name) throw new Error("wrangler.jsonc に env.preview.name がありません");
		return name;
	}
	const name = config.name;
	if (!name) throw new Error("wrangler.jsonc に name がありません");
	return name;
}

/**
 * Observability のクエリ parameters を組み立てる。
 * 複数レベルの OR は `in` 演算子が使えないため group フィルタで表現する
 * (フラットな filters は AND 結合される)。
 */
export function buildParameters({ worker, levels = [], grep, version }) {
	const filters = [
		{ key: "$metadata.service", operation: "eq", value: worker, type: "string" },
	];
	if (levels.length === 1) {
		filters.push({
			key: "$metadata.level",
			operation: "eq",
			value: levels[0],
			type: "string",
		});
	} else if (levels.length > 1) {
		filters.push({
			kind: "group",
			filterCombination: "or",
			filters: levels.map((level) => ({
				key: "$metadata.level",
				operation: "eq",
				value: level,
				type: "string",
			})),
		});
	}
	if (grep) {
		filters.push({
			key: "$metadata.message",
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

/** Cloudflare API を叩いて JSON を返す。success:false は例外にする。 */
async function callApi(url, token, init = {}) {
	const res = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const body = await res.json().catch(() => null);
	if (!body?.success) {
		// 失敗レスポンスは errors[] のことも error(zod issues) のこともある
		const detail =
			body?.errors?.map((e) => e.message).join(", ") ||
			(body?.error ? JSON.stringify(body.error) : `HTTP ${res.status}`);
		throw new Error(`Cloudflare API エラー: ${detail}`);
	}
	return body.result;
}

/** account id を解決する。環境変数が無ければアカウント一覧から一意に定まる場合のみ採用。 */
async function resolveAccountId(token) {
	const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (fromEnv) return fromEnv;
	const accounts = await callApi(`${API_BASE}/accounts`, token);
	if (accounts.length === 1) return accounts[0].id;
	throw new Error(
		`アカウントが一意に定まりません。CLOUDFLARE_ACCOUNT_ID を指定してください。\n` +
			accounts.map((a) => `  - ${a.id} (${a.name})`).join("\n"),
	);
}

/** message が配列(console.log の複数引数)でも文字列に潰す。 */
export function formatMessage(message) {
	if (Array.isArray(message)) {
		return message
			.map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
			.join(" ");
	}
	if (typeof message === "string") return message;
	if (message === undefined || message === null) return "";
	return JSON.stringify(message);
}

/** 1イベントを1行(+継続行はインデント)に整形する。 */
export function formatEvent(event) {
	const meta = event.$metadata ?? {};
	const time = new Date(event.timestamp).toISOString().replace("T", " ").slice(0, 23);
	const level = (meta.level ?? "-").toUpperCase().padEnd(5);
	const trigger = meta.trigger ? ` [${meta.trigger}]` : "";
	const message = formatMessage(meta.message);
	const [head, ...rest] = message.split("\n");
	const lines = [`${time}Z ${level}${trigger} ${head}`];
	for (const line of rest) lines.push(`  ${line}`);
	if (meta.requestId) lines.push(`  requestId=${meta.requestId}`);
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
				queryId: "wine-logs-cli",
				limit: opts.limit,
				view: "events",
				timeframe: { from, to },
				parameters: buildParameters({
					worker,
					levels: opts.levels,
					grep: opts.grep,
					version: opts.version,
				}),
			}),
		},
	);

	const events = result?.events?.events ?? [];
	if (opts.json) {
		console.log(JSON.stringify(events, null, 2));
		return 0;
	}

	// API は新しい順で返すため、tail と同じ「古い→新しい」に並べ替える
	const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
	console.log(
		`# ${worker} / 直近${opts.since} / ${sorted.length}件` +
			(opts.levels.length > 0 ? ` / level=${opts.levels.join(",")}` : "") +
			(opts.grep ? ` / grep=${opts.grep}` : "") +
			(opts.version ? ` / version=${opts.version}` : ""),
	);
	for (const event of sorted) console.log(formatEvent(event));

	if (sorted.length === 0) {
		console.log(
			"\nログがありません。次を確認してください:\n" +
				`  - 対象期間(--since ${opts.since})にその環境へのアクセスがあったか\n` +
				"  - PRごとのプレビューURL(<branch>-wine-preview.*)へのアクセスは、Cloudflare の\n" +
				"    制約でログに出ない(Preview URLs の Limitations)。--env preview で見えるのは\n" +
				"    デプロイ済み https://wine-preview.niboshi.workers.dev への分のみ\n" +
				"  - Workers Logs の保持期間(最大7日)を過ぎていないか",
		);
	}
	return 0;
}

// スクリプトとして直接実行された時のみ走らせる(import 時は純関数だけ使える)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
}
