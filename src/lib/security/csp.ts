// 全SSRページ共通の Content-Security-Policy 組み立て(単一入口)。
//
// 経路ごとに文字列を手書きしない。以前は `__root.tsx` が
// `frame-ancestors 'none'` だけを持ち、2つの埋め込みルートが CSP を `""` で
// 打ち消していた。ルート側にディレクティブを足すと埋め込み側だけ全保護が
// 消える取り残しが生まれるため、3箇所ともこの関数から導出する(#550)。
// 埋め込み側は `frame-ancestors` を落とすだけで、他のディレクティブは維持される。
//
// 現行ポリシー:
//   - 通常ページ: `frame-ancestors 'none'; base-uri 'self'; object-src 'none';
//     form-action 'self'`
//   - 埋め込み(`/embed/*`): 上から `frame-ancestors` を除いたもの(祖先不問)。
//     `frame-ancestors *` では足りない: MCP Apps ホストは App の HTML を sandbox
//     (allow-same-origin 無し)の iframe で描画するため、その中から開くこの
//     ページの祖先オリジンは不透明("null")になり、ネットワークスキームの URL
//     しか一致しない `*` にマッチせず読み込み自体が拒否される(#189)。空では
//     なく「当該ディレクティブ無し」で祖先を問わない。
//
// `base-uri 'self'` / `object-src 'none'` / `form-action 'self'` は壊れる
// リスクがほぼ無いため先に入れる:
//   - base-uri: `<base>` 差し替えによる相対 URL 乗っ取りを塞ぐ。アプリは
//     `<base>` を使わない
//   - object-src: `<object>` / `<embed>` / `<applet>` を全面禁止。アプリは
//     プラグイン系要素を使わない
//   - form-action: フォーム送信先を自オリジンに縛る。アプリのフォームは全て
//     JS の `onSubmit` ハンドラで処理し、ネイティブ送信しない。Stripe Checkout /
//     Billing Portal への遷移は `window.location` によるトップレベルナビゲーション
//     であり form-action の制約対象外なので影響しない
//
// script-src を含めない理由(段階的導入のため意図的に外す):
//   - `__root.tsx` の BOOT_SCRIPT(テーマ/スターターガイドのペイント前適用)が
//     インラインであり、`'unsafe-inline'` なしでは即座に壊れる
//   - TanStack Start が SSR 応答ごとに動的なインラインスクリプト(ストリーム
//     バリア・ルーターマニフェスト)を吐くため、静的 hash では固定できない。
//     nonce 化には `router.options.ssr.nonce` の配線とリクエストごとの nonce
//     発行→CSP ヘッダ反映が必要で、本PRの範囲を超える
//   - maplibre-gl のワーカーが `blob:` / `data:` URL から構築される
//     (`src/lib/wine/maplibre-worker.ts`)ため、script-src を足す場合は
//     worker-src の同時設計が要る
//   - `default-src` / `img-src` / `connect-src` も同様に未設定のままにする。
//     `default-src 'self'` を置くとベースマップ取得
//     (`https://tiles.openfreemap.org`)や Sentry 送信(`*.ingest.sentry.io`)の
//     fetch が巻き添えで遮断される。足す場合は report-only での違反観測を先に
//     行うこと
export interface CspOptions {
	/** true の場合、iframe 埋め込みを許可するため `frame-ancestors` を除く */
	allowEmbedding?: boolean;
}

const BASE_DIRECTIVES = [
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",
] as const;

const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * Content-Security-Policy ヘッダ値を組み立てる。`__root.tsx` と埋め込み
 * ルート(`/embed/map`, `/embed/drunk-wine`)の `headers()` が使う唯一の入口。
 */
export function buildCsp(options?: CspOptions): string {
	const directives = options?.allowEmbedding
		? [...BASE_DIRECTIVES]
		: [FRAME_ANCESTORS_NONE, ...BASE_DIRECTIVES];
	return directives.join("; ");
}
