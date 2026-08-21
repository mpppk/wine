// Langfuse へ送る入力から**写真そのものを外し、要約だけを載せる**ための純ロジック(#512/#514)。
//
// PII 方針(docs/deployment.md): Langfuse にはテキストの入出力を載せるが、写真は載せない。
// `langfuse-mask.ts` の mask フックが data URI を機械的に落とす**事後の関門**なのに対し、
// ここは**事前に** data URI を「MIME・寸法・バイト数・ハッシュ」へ置き換える。置き換えて
// おくことで、トレースを見たときに「写真が何枚で、どの大きさで、同じものかどうか」が
// 分かる(mask で落とすだけだと、そこに写真があったこと自体が消える)。
//
// ハッシュ計算(crypto.subtle)だけが非同期なので、**非同期は写像の構築時に済ませ**、
// 置き換え本体は同期関数にする。モデル呼び出しのコールバック(onLanguageModelCallEnd など)
// は同期的に報告するため、そこから await できないため。

export interface PhotoSummary {
	/** data URI の MIME(`image/jpeg` 等)。 */
	mime: string;
	/** 画像の幅(px)。ヘッダから読めなかった形式では省略。 */
	width?: number;
	/** 画像の高さ(px)。ヘッダから読めなかった形式では省略。 */
	height?: number;
	/** デコード後のおおよそのバイト数(base64 長から逆算)。 */
	approxBytes: number;
	/** base64 ペイロードの SHA-256(16進)。同じ写真かどうかの照合用。 */
	sha256: string;
}

/** 要約に置き換えたことを示すマーカーのキー。 */
const SUMMARY_KEY = "$photo";

/** data URI(`data:<mime>;base64,<payload>`)を分解する。失敗時は null。 */
function splitDataUrl(
	dataUrl: string,
): { mime: string; payload: string } | null {
	const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(
		dataUrl,
	);
	if (!match) return null;
	return { mime: match[1]!, payload: match[2]! };
}

/** base64 ペイロードのデコード後バイト数。末尾の `=` のぶんを引く。 */
function approxBytesOf(payload: string): number {
	const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** PNG の IHDR から寸法を読む(オフセット16から幅・高さの uint32 BE)。 */
function pngDimensions(
	bytes: Uint8Array,
): { width: number; height: number } | undefined {
	if (bytes.length < 24) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * JPEG の SOF セグメントから寸法を読む。セグメント列を先頭から辿り、
 * SOF0〜SOF15 のうち C4(DHT)/C8(JPG)/CC(DAC) 以外を見つけたら高さ・幅(uint16 BE)。
 */
function jpegDimensions(
	bytes: Uint8Array,
): { width: number; height: number } | undefined {
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) return undefined; // マーカー以外 = 解釈を諦める
		const marker = bytes[i + 1]!;
		if (
			marker === 0xd8 ||
			marker === 0x01 ||
			(marker >= 0xd0 && marker <= 0xd7)
		) {
			i += 2; // 単独マーカーは長さを持たない
			continue;
		}
		const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
		if (
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc
		) {
			if (i + 9 > bytes.length) return undefined;
			const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
			const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
			return { width, height };
		}
		i += 2 + length;
	}
	return undefined;
}

/** WebP のチャンクから寸法を読む(VP8X / VP8 / VP8L の3形式に対応)。 */
function webpDimensions(
	bytes: Uint8Array,
): { width: number; height: number } | undefined {
	if (bytes.length < 30) return undefined;
	const fourcc = String.fromCharCode(
		bytes[12]!,
		bytes[13]!,
		bytes[14]!,
		bytes[15]!,
	);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (fourcc === "VP8X" && bytes.length >= 30) {
		// 拡張形式。キャンバスサイズは24bit-1のLE(オフセット24/27)。
		const width =
			1 + ((bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) & 0xffffff);
		const height =
			1 + ((bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) & 0xffffff);
		return { width, height };
	}
	if (fourcc === "VP8 " && bytes.length >= 30) {
		// ロッシー形式。フレームタグの後の14bitずつ。
		return {
			width: view.getUint16(26, true) & 0x3fff,
			height: view.getUint16(28, true) & 0x3fff,
		};
	}
	if (fourcc === "VP8L" && bytes.length >= 25) {
		// ロスレス形式。シグネチャ(0x2f)の後の32bitに幅14bit+高さ14bitが詰まっている。
		if (bytes[20] !== 0x2f) return undefined;
		const bits = view.getUint32(21, true);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return undefined;
}

/** 画像バイト列の先頭ヘッダから寸法を読む。未知の形式では undefined。 */
function dimensionsOf(
	bytes: Uint8Array,
): { width: number; height: number } | undefined {
	try {
		if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngDimensions(bytes);
		if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
		if (
			bytes.length > 12 &&
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 &&
			bytes[10] === 0x42 &&
			bytes[11] === 0x50
		) {
			return webpDimensions(bytes);
		}
	} catch {
		// 寸法が取れないだけで要約は成立させる
	}
	return undefined;
}

/** data URI 1枚ぶんの要約を作る。解釈できない URI では throw しない(null)。 */
export async function describeDataUrl(
	dataUrl: string,
): Promise<PhotoSummary | null> {
	const parts = splitDataUrl(dataUrl);
	if (!parts) return null;
	try {
		const raw = atob(parts.payload);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return {
			mime: parts.mime,
			...dimensionsOf(bytes),
			approxBytes: approxBytesOf(parts.payload),
			sha256: toHex(new Uint8Array(digest)),
		};
	} catch {
		return null;
	}
}

/**
 * 複数枚ぶんの要約を一度に作る。generation の `metadata.photos`(写真インベントリ)の
 * 材料(#514)。**メタデータは入力テキストと別の属性**になるため、長いプロンプトが
 * mask に切り詰められてもインベントリは生きる。
 */
export async function describePhotoSummaries(
	dataUrls: readonly string[],
): Promise<PhotoSummary[]> {
	const summaries = await Promise.all(dataUrls.map(describeDataUrl));
	return summaries.filter((s): s is PhotoSummary => s !== null);
}

/**
 * data URI を要約へ置き換えるための**同期の**変換関数を作る。
 *
 * ハッシュ計算はここ(構築時)で済ませておく。モデル呼び出しのコールバックの中で
 * 報告するため、置き換え側を同期に保つ必要がある。写像に無い data URI(エージェント
 * ループが `zoom_photo` で切り出した画像など)は「在ったこと」だけを残して落とす
 * ——切り出し元と範囲は zoom_photo の span が持つので、ここで再現する必要はない。
 */
export async function createPhotoRedactor(
	dataUrls: readonly string[],
): Promise<(value: unknown) => unknown> {
	const map = new Map<string, PhotoSummary>();
	for (const dataUrl of dataUrls) {
		const summary = await describeDataUrl(dataUrl);
		if (summary) map.set(dataUrl, summary);
	}
	return function redact(value: unknown): unknown {
		if (typeof value === "string") {
			const summary = map.get(value);
			return summary ? { [SUMMARY_KEY]: summary } : value;
		}
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, v] of Object.entries(value)) out[key] = redact(v);
			return out;
		}
		return value;
	};
}
