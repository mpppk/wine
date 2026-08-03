// MapLibre のワーカー URL を、文書のオリジンに応じて解決する(Issue #194)。
//
// MCP Apps (SEP) ホストは App の HTML を sandbox(allow-same-origin 無し)の iframe で
// 描画する。sandbox フラグは**ネストしたブラウジングコンテキストに継承される**ため、
// その中から開く /embed/map の文書も不透明オリジンになる。
//
// Worker のスクリプトは same-origin でなければ構築できず、不透明オリジンはどの
// オリジンとも一致しないので、自オリジンのスクリプトであっても
//   SecurityError: Failed to construct 'Worker': Script at '.../maplibre-gl-worker-*.js'
//   cannot be accessed from origin 'null'
// で失敗する。worker が作れないとタイルのパースが一切走らず、地図が白いまま
// コントロールとアトリビューションだけが残る。
//
// blob URL は**生成元文書のオリジンを継承する**ため、不透明オリジンの文書が作った
// blob はその文書と same-origin になり Worker を構築できる(実機で確認済み)。
// スクリプト本体の取得はクロスオリジン fetch になるが、/assets/* には
// `Access-Control-Allow-Origin: *` が付いている(public/_headers。#189 で module
// script のために追加済み)。
//
// なお ACAO を足すだけでは解決しない。Worker の生成は CORS ではなく same-origin の
// 制約で、不透明オリジンはどのオリジンとも一致しないため。

/**
 * 文書のオリジンが不透明(sandbox 由来)か。SSR では false。
 *
 * **`location.origin` を見てはいけない**。あれは文書の *URL* 由来なので、sandbox で
 * オリジンが不透明化されていても元のオリジンを返す。実機で計測すると、同じ文書で
 * `location.origin` が "http://localhost:4173"、`window.origin` が "null" になる。
 * 見るべきは環境設定オブジェクトのオリジンを返す `window.origin` のほう。
 *
 * さらに blob URL のオリジン継承でも裏を取る。ここで判定を誤ると「地図が白いまま」
 * という原因の分かりにくい壊れ方をするため、判定材料を1つに賭けない。
 */
export function hasOpaqueOrigin(): boolean {
	if (typeof window === "undefined") return false;
	if (window.origin === "null") return true;
	try {
		const probe = URL.createObjectURL(new Blob([]));
		try {
			return probe.startsWith("blob:null/");
		} finally {
			URL.revokeObjectURL(probe);
		}
	} catch {
		return false;
	}
}

/**
 * 通常のオリジンでは受け取った URL をそのまま返す(既存経路の挙動を変えない)。
 * 不透明オリジンのときだけスクリプトを取得して data: URL 化する(#368。blob:
 * ではない理由は下記 `WORKER_DATA_URL_SUFFIX` のコメント参照)。
 *
 * 取得に失敗しても例外にはしない。ここで投げると地図の初期化ごと止まってしまう
 * ため、元の URL を返して maplibre 側の既存のエラー経路に委ねる。ただし原因を
 * 追えなくしないよう警告は残す。
 */
export async function resolveMaplibreWorkerUrl(
	workerUrl: string,
): Promise<string> {
	if (!hasOpaqueOrigin()) return workerUrl;
	try {
		const res = await fetch(workerUrl);
		if (!res.ok) {
			console.warn(
				`maplibre worker: failed to fetch ${workerUrl} (${res.status})`,
			);
			return workerUrl;
		}
		const code = await res.text();
		return `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}${WORKER_DATA_URL_SUFFIX}`;
	} catch (e) {
		console.warn("maplibre worker: failed to build a blob worker URL", e);
		return workerUrl;
	}
}

// maplibre-gl 自身の `workerFactory()` は `config.WORKER_URL`(＝上で解決した URL)を
// 受け取ると、`isCrossOrigin(url)`(`new URL(url, location.href).origin !==
// location.href`)で毎回 URL の同一オリジン性を再判定する。ここで見る
// `location.origin` は上の `hasOpaqueOrigin()` のコメントの通り不透明化されない
// (元のオリジンを返す)ため、不透明オリジンの文書が作った blob:/data: URL は
// 常に「クロスオリジン」と誤判定される。
//
// クロスオリジンと判定された場合、maplibre は URL の末尾が `.cjs` でなければ
// (＝ほぼ常に)「モジュールワーカー」とみなし、渡された URL をそのまま
// `import "<url>"` という**別の**モジュールスクリプトで包んでから
// `new Worker(wrapped, {type: "module"})` を構築する(生成直後に
// `URL.revokeObjectURL` で失効させる実装もあり、これ自体も別のリスクを持つ)。
// 不透明オリジンの文書ではこの二重包装後の `import` が解決されず、Worker は
// 例外を投げることもなく生成直後にサイレントに閉じる。これが描画されない
// (エラーも出ない)本Issueの実体で、maplibre 側の内部実装(非公開の
// `workerFactory`)に起因するため、アプリ側からは差し替えられない。
//
// `.cjs` で終わる URL を渡すと `asModule` が false になり、maplibre は代わりに
// (実績のある)「fetch して classic worker 用の blob を作る」経路
// (`fetchAsBlobUrl` → `new Worker(blobUrl)`、type 指定なし)を通る。data: URL は
// フラグメント(`#...`)を付けても取得されるデータそのものは変わらないため、
// 末尾に `#maplibre-gl-worker.cjs` を付けるだけで
// - `isCrossOrigin` はそのまま true(data: URL は本来的に不透明オリジンなので
//   `location.origin` と一致せず、意図通りクロスオリジン扱いになる)
// - `asModule` は false(URL 文字列が `.cjs` で終わる)
// の両方を同時に満たせる。`blob:` ではなく `data:` を使うのは、`blob:` URL は
// パス末尾がランダムな UUID で固定されており `.cjs` を付ける余地がないため。
const WORKER_DATA_URL_SUFFIX = "#maplibre-gl-worker.cjs";
