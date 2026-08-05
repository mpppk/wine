// Sentry の Store/Envelope エンドポイントへ送る1件ぶんを組み立てる純ロジック。
//
// **SDK を使わない**理由: `@sentry/react` はブラウザ専用で、SSR(workerd)ビルドに
// 混ざると Worker が壊れる(client-error.ts の冒頭コメント参照。
// `@sentry/tanstackstart-react` が Workers 非対応なのも同じ事情)。
// サーバ側から送りたいのは「運用者が手を動かす必要がある少数の事象」だけなので、
// SDK の機能(自動計装・ブレッドクラム・トレース)は要らない。envelope は
// **改行区切りのJSON3行**という単純な形式で、`fetch` だけで送れる。
//
// このファイルは `cloudflare:workers` に依存しない純関数だけを持つ(jsdom の
// unit テストで組み立て結果を固定するため)。実際の送信は operator-alert.ts。

/** DSN から送信先URLと公開キーを取り出した結果。 */
export interface SentryDsn {
	/** envelope の POST 先。 */
	endpoint: string;
	publicKey: string;
	projectId: string;
}

/**
 * `https://<publicKey>@<host>/<projectId>` を分解する。
 * 形式が違えば null(未設定・設定ミスで送信を試みない)。
 */
export function parseSentryDsn(dsn: string): SentryDsn | null {
	const trimmed = dsn.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	const publicKey = url.username;
	// パスの末尾がプロジェクトID。Sentry のセルフホストではプレフィックスが付きうる。
	const segments = url.pathname.split("/").filter(Boolean);
	const projectId = segments.at(-1) ?? "";
	if (!publicKey || !projectId) return null;
	const prefix = segments.slice(0, -1).join("/");
	const base = `${url.origin}${prefix ? `/${prefix}` : ""}`;
	return {
		endpoint: `${base}/api/${projectId}/envelope/`,
		publicKey,
		projectId,
	};
}

/** 送信するイベントの重大度。Sentry のアラートルールはこれで絞れる。 */
export type SentryLevel = "error" | "warning";

export interface SentryEventInput {
	message: string;
	level: SentryLevel;
	/** 環境名(production / preview / local)。本番のイベントと混ざらないようにする。 */
	environment: string;
	/** 検索・アラート条件に使う短い値だけを入れる。 */
	tags: Record<string, string>;
	/** 補助情報。**PII と機微情報を入れないのは呼び出し側の責任**。 */
	extra: Record<string, unknown>;
	/** イベントID(32桁hex)と発生時刻。テストから固定するため引数で受ける。 */
	eventId: string;
	timestampMs: number;
}

/**
 * envelope の本文を組み立てる。3行構成:
 *   1. envelope ヘッダ(event_id / sent_at)
 *   2. アイテムヘッダ(type=event)
 *   3. イベント本体
 *
 * `logger: "worker"` を固定で入れるのは、**クライアント由来のイベントと同じ
 * プロジェクトに送っても区別できるようにする**ため(#395)。
 */
export function buildSentryEnvelope(input: SentryEventInput): string {
	const sentAt = new Date(input.timestampMs).toISOString();
	const header = { event_id: input.eventId, sent_at: sentAt };
	const itemHeader = { type: "event" };
	const event = {
		event_id: input.eventId,
		timestamp: input.timestampMs / 1000,
		platform: "javascript",
		logger: "worker",
		level: input.level,
		environment: input.environment,
		message: { formatted: input.message },
		tags: { ...input.tags, runtime: "workers" },
		extra: input.extra,
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(event)}\n`;
}

/**
 * 送信先ホスト名から環境名を導出する。クライアント側(sentry-client.ts の
 * `resolveEnvironment`)と同じ対応にする——**片方だけ足すと同じ障害が2つの
 * environment に割れて見える**。
 */
export function resolveServerEnvironment(baseUrl: string | undefined): string {
	if (!baseUrl) return "local";
	let host: string;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		return "local";
	}
	if (host === "wine.nibo.sh") return "production";
	if (host === "localhost" || host === "127.0.0.1") return "local";
	return "preview";
}
