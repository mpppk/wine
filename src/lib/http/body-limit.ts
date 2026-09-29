// リクエスト本文のバイト上限の共通関門(Issue #639)。
//
// #398 で `readImageFormData`(images/form-api.ts)に「実際に流れたバイト数で打ち切る」
// 上限を入れたが、適用先はフォーム系 API ルートだけだった。他の入口は本文を全量
// メモリに載せてから検証する:
//
//  - `/api/mcp`: `transport.handleRequest(req)` が JSON を全量パースしてから
//    zod(`photo_base64` は `max(7_100_000)`)で検証する(要 OAuth トークン)
//  - `/api/auth/*`: better-auth が JSON を全量パース(**未認証で到達可能**)
//  - server fn: TanStack Start がペイロードをデシリアライズしてからミドルウェアが走る
//
// `Transfer-Encoding: chunked` の大きな本文を並行に送れば、#398 と同じく isolate の
// メモリを圧迫できる。そこで `src/worker.ts` の `fetch` ラッパが全リクエストに
// この関門を掛け、Content-Length の早期拒否 + ストリームの打ち切りを行う。
//
// **フォーム系ルートはここを通さない**。1エントリ6枚(約31MB)・一括登録10枚
// (約52MB)と個別の上限(`maxFormDataBytes`)を持ち、共通の 10MB を掛けると正当な
// 写真アップロードが壊れる。あちらは `readImageFormData` が同じ打ち切り方式で
// 守っているので、ここでは対象外にして二重に読まない。
//
// 判定・換算ロジックをここに寄せる理由は #174 と同じで、経路ごとに上限を書くと
// 後発の経路で必ず適用漏れする。新しい入口を足すときは `resolveBodyLimit` の
// 1箇所だけを見ればよい。

/** 全体共通の本文上限(10MB)。JSON 系の正当なペイロードは数KB〜数百KBなので十分な幅。 */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * `/api/mcp` の本文上限(12MB)。
 *
 * MCP の `photo_base64` は zod で `max(7_100_000)`(約6.8MBの base64 = デコード後
 * 5MB)まで許す。JSON-RPC/MCP のエンベロープと他の引数を足しても 8MB に収まる
 * 想定で、余白を見て 12MB にする。共通の 10MB では最大長の base64 に
 * エンベロープを足した正当な呼び出しが境界で落ちうるため、個別に持つ。
 */
export const MCP_MAX_BODY_BYTES = 12 * 1024 * 1024;

/** 上限超過の応答本文。API ルートの `{ error }` 形に合わせる。 */
export const BODY_TOO_LARGE_MESSAGE = "Request body too large";

/**
 * フォーム系ルートのパス。`readImageFormData` が独自の上限(`maxFormDataBytes`)
 * で守っているため、共通関門の対象外にする(ここで 10MB を掛けると正当な
 * 写真アップロードが壊れる)。
 */
const FORM_BODY_PATHS = new Set([
	"/api/upload",
	"/api/wine-photos",
	"/api/import-batch-photos",
	"/api/label-analysis-jobs",
]);

/**
 * パスから本文上限を解決する。フォーム系は null(=共通関門の対象外で、
 * ルート側の `readImageFormData` が守る)。
 */
export function resolveBodyLimit(pathname: string): number | null {
	if (FORM_BODY_PATHS.has(pathname)) return null;
	if (pathname === "/api/mcp") return MCP_MAX_BODY_BYTES;
	return DEFAULT_MAX_BODY_BYTES;
}

/**
 * ボディを読みながら上限バイト数で打ち切るリクエストを作る。
 *
 * `exceeded()` は「上限超過で打ち切ったか」を返す。ストリームのエラーは
 * 下流の `formData()`/`json()` の例外として出てくるが、**例外の型・メッセージは
 * ランタイム依存**なので種類の判別には使わず、このフラグで見る。
 */
export function withBodyLimit(
	request: Request,
	limit: number,
): { request: Request; exceeded: () => boolean } {
	const body = request.body;
	// ボディの無いリクエストは打ち切りようがない(下流が 400 にする)。
	if (!body) return { request, exceeded: () => false };

	let seen = 0;
	let over = false;
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (over) return;
			seen += chunk.byteLength;
			if (seen > limit) {
				over = true;
				// **error ではなく terminate で打ち切る**。error にすると下流に例外が伝播する
				// 経路が増え、どこかで未処理の rejection としてランタイムに漏れて
				// 「超過リクエストのたびにエラーログが出る」(攻撃者が任意に量産できる
				// ログノイズになる)。terminate なら下流は「本文が途中で終わった」だけを見る。
				// 打ち切ったかどうかは over フラグで判る。
				controller.terminate();
				return;
			}
			controller.enqueue(chunk);
		},
	});

	// 打ち切り時は書き込み側が閉じ、pipeTo は reject して上流の読み取りをキャンセルする
	// (= 上限を超えたバイトはメモリに載らない)。その reject は想定内なので握りつぶす。
	void body.pipeTo(writable).catch(() => {});

	return {
		request: new Request(request.url, {
			method: request.method,
			// multipart の boundary を含む content-type を保つ(無いとパースできない)。
			headers: request.headers,
			body: readable,
			// ストリームをボディにする場合に必須。workerd の型には無いが、
			// Request の初期化オプションとしては受け付ける。
			duplex: "half",
		} as RequestInit),
		exceeded: () => over,
	};
}

function bodyTooLargeResponse(): Response {
	return new Response(JSON.stringify({ error: BODY_TOO_LARGE_MESSAGE }), {
		status: 413,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * `src/worker.ts` の `fetch` ラッパが使う全体関門。
 *
 * - 対象外パス(フォーム系)・ボディを持たない GET/HEAD はそのまま通す。
 * - `Content-Length` の申告値が上限を超えていたら**ボディを読まずに 413**
 *   (正直なクライアントの早期リターン)。
 * - 申告が無い/過少申告でも、**実際に流れたバイト数**を数えて上限を超えたら
 *   読むのをやめて 413(上限を超えたバイトはメモリに載らない)。
 * - 上限内なら本文をバッファして新しい Request として下流へ渡す。下流は
 *   `json()`/`formData()` を普段どおり読める。
 *
 * 超過はログに出さない(攻撃者が任意に量産できる正常系の 4xx のため)。
 */
export async function enforceBodyLimit(
	request: Request,
): Promise<Request | Response> {
	const method = request.method.toUpperCase();
	// GET/HEAD はボディを読まない経路なので対象外にする。本文が付いていても
	// 下流は読まず、未読のストリームはメモリに載らない。
	if (method === "GET" || method === "HEAD") return request;

	const limit = resolveBodyLimit(new URL(request.url).pathname);
	// フォーム系はルート側の `readImageFormData` が独自上限で守る。
	if (limit === null) return request;

	// 申告値が既に超過なら、ボディを読まずに弾く。
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > limit) return bodyTooLargeResponse();

	const body = request.body;
	// ボディの無いリクエストは打ち切りようがない(下流が 400 等にする)。
	if (!body) return request;

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel().catch(() => {});
				return bodyTooLargeResponse();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	// 上限内ならバッファを新しいボディにして下流へ渡す。
	const buffered = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffered.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: buffered,
		duplex: "half",
	} as RequestInit);
}
