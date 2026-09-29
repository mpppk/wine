import * as Sentry from "@sentry/cloudflare";
import { errToString, type LogFields, logError, logWarn } from "#/lib/logger";

// **運用者が手を動かさないと直らない**サーバ側の事象を、ログに加えて外部へ通知する
// 唯一の入口(Issue #395)。
//
// なぜ要るか: サーバの `logError` は Workers Logs への fire-and-forget で、消費するのは
// 人が `bun run logs --level error` を叩いたときだけ。シークレットのローテーション後に
// Stripe webhook の署名検証が静かに壊れる、返金が失敗してユーザが失敗した推論の料金を
// 負担したまま——といった事象は、**誰も見ていない間ログが増え続ける**。予期しない例外は
// `withSentry`(#486)が自動で拾うが、「意図して選んだ少数の事象」はここを通す。
//
// なぜ全部の logError を送らないか: 24箇所ある `logError` の多くは D1 の一時障害や
// ユーザ入力起因で、**自動で回復するか、人が何かしても直らない**。全部送ると通知が
// 形骸化して、本当に手を動かすべき5件が埋もれる。ここを通すのは
// 「**放置するとユーザの金銭・権利が宙に浮いたままになる**」ものに限る。
//
// なぜ SDK か(#649): #395 当時は `@sentry/cloudflare` が無く、envelope を手で組んで
// `fetch` していた。`src/worker.ts` の `withSentry` 導入(#486)で同じプロジェクトへの
// 送信が2系統になり、環境名の導出・PII の方針・リトライやフラッシュの挙動が別々に
// 保守されていた。片方だけ直すとドリフトするので、送信は SDK に寄せる。
// DSN 未設定の判定・environment(`resolveServerEnvironment` を `worker.ts` で解決済み)・
// PII の抑止(`dataCollection` を全閉じ)・送信の待機はすべて `withSentry` の初期化に
// 委ね、ここでは environment を手で付けない。片方だけ足すと同じ障害が2つの
// environment に割れて見えるドリフトを繰り返さないため。

/** 送信に失敗しても呼び出し元へ伝播させないための印(テストから観測する)。 */
const ALERT_SEND_FAILED = "operator alert delivery failed";

/** 通知に載せるタグ。検索とアラート条件に使うので短い値だけ。 */
export interface OperatorAlertOptions {
	/** 既定は "error"。恒常監視だが即時対応でないものは "warning"。 */
	level?: "error" | "warning";
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
		// Error はそのままでは JSON にならないので、ログと同じ畳み方で文字列にする。
		const extra = Object.fromEntries(
			Object.entries(fields).map(([k, v]) => [
				k,
				v instanceof Error ? errToString(v) : v,
			]),
		);
		// クライアント由来のイベントと同じプロジェクトに送っても区別できるよう
		// `runtime: "workers"` を必ず付ける(Sentry 側は `tags[runtime]` で絞れる)。
		const tags = { runtime: "workers", ...options.tags };
		const err = fields.err;
		if (err instanceof Error) {
			// 運用メッセージを表題に残したまま、原因のスタックも辿れるようにする。
			// `linkedErrorsIntegration`(SDK 既定)が `cause` の連鎖を辿るので、
			// 元の例外のスタックはそちらに残り、extra 側の文字列は検索用になる。
			Sentry.captureException(new Error(msg, { cause: err }), {
				level,
				tags,
				extra,
			});
		} else {
			Sentry.captureMessage(msg, { level, tags, extra });
		}
	} catch (e) {
		// 収集基盤の失敗で元の処理を巻き込まない。
		logWarn(ALERT_SEND_FAILED, { err: errToString(e) });
	}
}
