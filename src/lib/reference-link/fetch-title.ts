// 参考リンクのタイトル自動取得。ユーザがタイトルを未入力のとき、リンク先ページの
// <title> / og:title からそれらしいタイトルを作る。
//
// テストは jsdom 環境(HTMLRewriter 等の Workers API 不可)で動くため、HTMLの解析は
// 純粋関数 extractTitleFromHtml に閉じ込め単体テスト可能にする。ネットワーク処理
// (fetchPageTitle)はサーバ専用で、失敗しても例外を投げず null を返す。

import { logWarn } from "#/lib/logger";

const MAX_TITLE_LENGTH = 200;
// タイトル抽出のために読むHTMLの上限(先頭にある <head> だけ読めれば十分)
const MAX_HTML_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 4000;

/** 最小限のHTMLエンティティをデコードする(タイトルに現れる代表的なものだけ) */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) =>
			String.fromCodePoint(parseInt(h, 16)),
		);
}

/** 空白(改行・連続スペース)を1つに畳み、前後を除去し、上限長に丸める */
function normalizeTitle(raw: string): string | null {
	const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > MAX_TITLE_LENGTH
		? text.slice(0, MAX_TITLE_LENGTH).trim()
		: text;
}

/**
 * HTML文字列からタイトルを抽出する。og:title(SNS向けに整形された題)を優先し、
 * 無ければ <title> を使う。どちらも無ければ null。純粋関数(I/Oなし)。
 */
export function extractTitleFromHtml(html: string): string | null {
	// og:title は property/content の順序が入れ替わることがあるため両順に対応する
	const ogTitle =
		html.match(
			/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
		)?.[1] ??
		html.match(
			/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i,
		)?.[1];
	if (ogTitle) {
		const t = normalizeTitle(ogTitle);
		if (t) return t;
	}

	const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	if (titleTag) {
		const t = normalizeTitle(titleTag);
		if (t) return t;
	}

	return null;
}

/**
 * 明らかに外部公開でないホスト(内部アドレス)への取得を防ぐ簡易SSRFガード。
 * Workers の fetch は基本的にパブリック向けだが、念のためローカル/プライベート帯を弾く。
 */
function isFetchableHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".local")) return false;
	if (host === "::1" || host === "[::1]") return false;
	// IPv4 のプライベート/リンクローカル/ループバック帯
	if (/^127\./.test(host)) return false;
	if (/^10\./.test(host)) return false;
	if (/^192\.168\./.test(host)) return false;
	if (/^169\.254\./.test(host)) return false;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
	if (host === "0.0.0.0") return false;
	return true;
}

/**
 * リンク先ページのタイトルを取得する。取得できない(タイムアウト・非HTML・エラー等)
 * ときは例外を投げず null を返す。呼び出し側は null を「タイトル未確定(URL表示で代替)」
 * として扱う。
 */
export async function fetchPageTitle(url: string): Promise<string | null> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (!isFetchableHost(parsed.hostname)) return null;

	try {
		const res = await fetch(parsed, {
			method: "GET",
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				// 一般的なブラウザ相当のUAとHTML希望を伝える
				"user-agent":
					"Mozilla/5.0 (compatible; wine-app/1.0; +https://wine.nibo.sh)",
				accept: "text/html,application/xhtml+xml",
			},
		});
		if (!res.ok || !res.body) {
			// 特定サイトでタイトル取得が常に失敗しても気づけるよう記録する。ユーザ入力の
			// URL 全体ではなく hostname に留める(#156)。
			logWarn("page title fetch failed", {
				hostname: parsed.hostname,
				status: res.status,
			});
			return null;
		}
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("text/html")) {
			logWarn("page title non-html", {
				hostname: parsed.hostname,
				contentType,
			});
			return null;
		}

		// 先頭 MAX_HTML_BYTES だけ読む(<head> が取れれば十分。巨大ページを全部読まない)
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let html = "";
		let received = 0;
		while (received < MAX_HTML_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			html += decoder.decode(value, { stream: true });
			// </head> まで読めたら以降は不要
			if (/<\/head>/i.test(html)) break;
		}
		await reader.cancel().catch(() => {});
		return extractTitleFromHtml(html);
	} catch (e) {
		// タイムアウト/ネットワーク例外/読み取りエラー。SSRFガードが弾いた試行も含め、
		// hostname 単位で記録する(URL全体は残さない)(#156)。
		logWarn("page title fetch error", { hostname: parsed.hostname, err: e });
		return null;
	}
}
