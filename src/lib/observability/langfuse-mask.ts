// Langfuse へ送る直前のマスク処理の唯一の関門(#512)。
//
// PII 方針: Langfuse にはテキストの入出力を載せるが、写真そのものは載せない。
// `mediaUploadEnabled: false` でメディアストレージへのアップロードは塞いであるが、
// ここではさらに機械的に機微な値を落とす。純関数として unit テストで固定する。
//
// 対象:
//  - `data:` URI（写真の base64 そのものや、誤って input に紛れ込んだもの）
//  - base64 らしき長大文字列（写真由来でなくても写真と誤認されうるもの）
//  - 認証情報らしき値（`sk-…` / `pk-lf-…` / `Bearer …`）
//  - 長すぎるテキスト（切り詰めたことが分かる形で）

const DATA_URI_RE = /data:[^,\s]*;base64,[A-Za-z0-9+/=]+/g;
const DATA_URI_ANY_RE = /data:[^\s"]{8,}/g;
const LONG_BASE64_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;
const SK_RE = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const PK_LF_RE = /\bpk-lf-[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

const TRUNCATE_LIMIT = 8000;

function maskString(value: string): string {
	let out = value;
	out = out.replace(DATA_URI_RE, "[data URI omitted]");
	out = out.replace(DATA_URI_ANY_RE, "[data URI omitted]");
	out = out.replace(LONG_BASE64_RE, "[base64 omitted]");
	out = out.replace(SK_RE, "[secret omitted]");
	out = out.replace(PK_LF_RE, "[secret omitted]");
	out = out.replace(BEARER_RE, "Bearer [secret omitted]");
	if (out.length > TRUNCATE_LIMIT) {
		out = `${out.slice(0, TRUNCATE_LIMIT)}...[truncated: ${out.length - TRUNCATE_LIMIT} chars omitted]`;
	}
	return out;
}

/**
 * LangfuseSpanProcessor の `mask` フックに渡す純関数。
 * `span.attributes` の `input` / `output` / `metadata` が対象で、値は文字列
 * （`input` が文字列ならそのまま、オブジェクトなら JSON.stringify 済み）が来る。
 * 文字列以外は素通しする。
 */
export function langfuseMask({ data }: { data: unknown }): unknown {
	if (typeof data === "string") return maskString(data);
	return data;
}
