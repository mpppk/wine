import { tracing } from "cloudflare:workers";

// カスタムスパンを張る**唯一の入口**(Issue #504)。
//
// なぜ要るか: `observability.traces` の自動計装は fetch/queue ハンドラ・D1・R2・Images・
// Queues・Rate limiting・外向き fetch を拾うが、**Workers AI(`env.AI`)は対象外**で、
// このアプリで最も遅く最も壊れる推論経路がトレースに現れない。キューのコンシューマも
// 「1バッチ = 1スパン」なので、バッチ内のどのジョブが遅かったかは分からない。
//
// なぜ1箇所に寄せるか: `tracing.enterSpan` を経路ごとに直書きすると、後から足した経路で
// 必ず漏れる(構造化ログが新ドメイン群で未適用になった #166、MIME検証がワイン写真経路に
// 未適用だった #174 と同じ再演)。属性名も散らばると横断で絞れなくなり、計装があるのに
// 「AI経路だけまとめて見る」ができない状態になる。
//
// ## スパンに載せてよいもの
//
// **実行メタデータだけ**。userId・ワイン名・検索クエリのような「誰が何をしたか」が
// 復元できる値は載せない。同種の値が Workers Logs には載っているが、あれは保持7日・
// 閲覧に `CLOUDFLARE_API_TOKEN` が要るという前提の上での判断で(docs/deployment.md)、
// **スパンは OTLP エクスポートを1つ設定した時点で外部の別基盤へ出ていく**。ログ側と
// 突き合わせたいときは `requestId` を載せておけば繋がる(台帳・実行記録と同じキー)。
//
// **Langfuse は別基準**。テキストの入出力を載せることが価値の中心なので、
// `src/lib/observability/langfuse.ts` が唯一の入口として、写真を除いたテキスト入出力を
// `mask` 関門を通して送る。保持30日・キー必須という別の前提に依る。詳細は
// `docs/deployment.md` の「Langfuse でのAI推論トレース」を参照。

/** スパンに付ける属性。`undefined` の値は捨てる(「渡していない」を属性にしない)。 */
export type SpanAttributes = Record<
	string,
	string | number | boolean | undefined
>;

export interface SpanHandle {
	/** 実行中に判明した属性を足す(結末・実際に使ったモデル・実測原価など)。 */
	set(attributes: SpanAttributes): void;
}

/** トレース無効時・未対応ランタイム向けの捨て先。 */
const NOOP_SPAN: SpanHandle = { set() {} };

function apply(span: Span, attributes: SpanAttributes): void {
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		span.setAttribute(key, value);
	}
}

/**
 * `fn` の実行を1つのスパンで囲む。スパンは `fn` の戻り(同期・Promise どちらも)で閉じる。
 *
 * **`fn` の例外はそのまま伝播する**(スパンには失敗として記録される)。計装が理由で
 * 呼び出し側の挙動が変わることは無く、トレースが無効な環境では素通しになる。
 *
 * 属性は「開始時点で分かっているもの」を第2引数で渡し、実行中に判明したものは
 * `span.set()` で足す。**開始時点の分をコールバック内で足さない**——`fn` が throw
 * したときに落ちてしまい、失敗したスパンほど属性が薄くなる。
 */
export function withSpan<T>(
	name: string,
	attributes: SpanAttributes,
	fn: (span: SpanHandle) => T,
): T {
	// 未対応ランタイム(古い workerd)では計装ごと諦めて素通しする。可観測性の都合で
	// 本処理を落とさない——observability/ の他のモジュールと同じ方針。
	if (typeof tracing.enterSpan !== "function") return fn(NOOP_SPAN);
	return tracing.enterSpan(name, (span) => {
		apply(span, attributes);
		return fn({ set: (extra) => apply(span, extra) });
	});
}
