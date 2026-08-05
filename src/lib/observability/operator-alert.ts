import { env, waitUntil } from "cloudflare:workers";
import { errToString, type LogFields, logError, logWarn } from "#/lib/logger";
import {
	buildSentryEnvelope,
	parseSentryDsn,
	resolveServerEnvironment,
	type SentryLevel,
} from "./sentry-envelope";

// **運用者が手を動かさないと直らない**サーバ側の事象を、ログに加えて外部へ通知する
// 唯一の入口(Issue #395)。
//
// なぜ要るか: サーバの `logError` は Workers Logs への fire-and-forget で、消費するのは
// 人が `bun run logs --level error` を叩いたときだけ。シークレットのローテーション後に
// Stripe webhook の署名検証が静かに壊れる、返金が失敗してユーザが失敗した推論の料金を
// 負担したまま——といった事象は、**誰も見ていない間ログが増え続ける**。Sentry(#382)は
// 意図的にクライアント専用だったので、サーバ側には通知経路が1本も無かった。
//
// なぜ全部の logError を送らないか: 24箇所ある `logError` の多くは D1 の一時障害や
// ユーザ入力起因で、**自動で回復するか、人が何かしても直らない**。全部送ると通知が
// 形骸化して、本当に手を動かすべき5件が埋もれる。ここを通すのは
// 「**放置するとユーザの金銭・権利が宙に浮いたままになる**」ものに限る。
//
// なぜ Sentry か: 既に導入済みで(クライアント側 #381/#382)、重複集約・アラートルール・
// 通知先連携という「通知を運用する」部分が既にある。ここで作るのは envelope を1本
// POST するだけの薄い口で、SDK は読み込まない(sentry-envelope.ts の冒頭参照)。

/** 送信に失敗しても呼び出し元へ伝播させないための印(テストから観測する)。 */
const ALERT_SEND_FAILED = "operator alert delivery failed";

/**
 * サーバ側の DSN。**クライアントの `VITE_SENTRY_DSN`(ビルド変数)とは別に、
 * Worker のシークレット/変数として渡す**。未設定なら送信しない(ログは出る)。
 */
function dsn(): string {
	return (env as { SENTRY_DSN?: string }).SENTRY_DSN?.trim() ?? "";
}

function eventId(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

/**
 * envelope を1本送る。**待たない**が、レスポンス返却でリクエストが打ち切られると
 * fetch ごと捨てられるため `waitUntil` に載せる(credit-service の #246 と同じ理由)。
 * `waitUntil` が使えない文脈(テスト・Cron)では素通しする。
 */
function send(body: string, endpoint: string, publicKey: string): void {
	const work = fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-sentry-envelope",
			"X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=wine-worker/1`,
		},
		body,
	})
		.then((res) => {
			// 送信の失敗は**ログにだけ**残す。ここで throw すると、元のエラー処理中の
			// 呼び出し元に別の失敗が被さる。
			if (!res.ok) logWarn(ALERT_SEND_FAILED, { status: res.status });
		})
		.catch((e) => {
			logWarn(ALERT_SEND_FAILED, { err: errToString(e) });
		});
	try {
		waitUntil(work);
	} catch {
		// リクエスト文脈の外(テスト等)。fetch は走っているのでそのままにする。
	}
}

/** 通知に載せるタグ。検索とアラート条件に使うので短い値だけ。 */
export interface OperatorAlertOptions {
	/** 既定は "error"。恒常監視だが即時対応でないものは "warning"。 */
	level?: SentryLevel;
	/** アラートルールで絞るためのタグ(例: kind, feature)。 */
	tags?: Record<string, string>;
}

/**
 * 運用者向けの通知を出す。**必ずログにも残す**(通知先が未設定でも記録は残る)。
 * この関数は決して throw しない。
 *
 * `fields` はそのまま Sentry の extra に載る。**PII と機微情報を入れないこと**——
 * 特に AI 実行記録の `webResearch` / `fieldSources` は解析した銘柄が復元できるため、
 * Workers Logs(保持7日・APIトークン必須)に限る取り決めになっている
 * (docs/deployment.md)。ここへ渡す値は呼び出し側で選ぶ。
 */
export function alertOperator(
	msg: string,
	fields: LogFields = {},
	options: OperatorAlertOptions = {},
): void {
	const level = options.level ?? "error";
	// ログ側は従来どおりの構造化1行。`operator` を立てておくと
	// `bun run logs --grep operator` で通知対象だけを絞れる。
	const logFields = { ...fields, operator: true };
	if (level === "error") logError(msg, logFields);
	else logWarn(msg, logFields);

	try {
		const parsed = parseSentryDsn(dsn());
		if (!parsed) return;
		const body = buildSentryEnvelope({
			message: msg,
			level,
			environment: resolveServerEnvironment(
				(env as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL,
			),
			tags: options.tags ?? {},
			// Error はそのままでは JSON にならないので、ログと同じ畳み方で文字列にする。
			extra: Object.fromEntries(
				Object.entries(fields).map(([k, v]) => [
					k,
					v instanceof Error ? errToString(v) : v,
				]),
			),
			eventId: eventId(),
			timestampMs: Date.now(),
		});
		send(body, parsed.endpoint, parsed.publicKey);
	} catch (e) {
		// DSN の形が壊れている等。通知の失敗で元の処理を巻き込まない。
		logWarn(ALERT_SEND_FAILED, { err: errToString(e) });
	}
}
