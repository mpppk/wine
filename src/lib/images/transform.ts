import { env } from "cloudflare:workers";
import { parseImageDataUrl } from "#/lib/ai/label-extraction";
import {
	type CropResolution,
	type NormalizedBox,
	resolveCropBox,
	resolveOutputWidth,
} from "./crop-geometry";

// Cloudflare Images バインディング(`env.IMAGES`)の薄いラッパ。
//
// エチケット解析の `zoom_photo` が使う。**なぜサーバ側で切るのか**: 解析はページを
// 閉じた後もバックグラウンドで続けられるようにする方針(ジョブ化)なので、原寸を
// 持っているのがクライアントだけ、という形は取れない。
//
// 幾何(どこを切るか)は crop-geometry.ts の純ロジックに分けてあり、ここは
// 「data URI を受けて data URI を返す」入出力の変換だけを持つ。

/** 変換結果。data URI と、実際に適用した領域。 */
export interface CroppedImage {
	/** 切り出した画像の data URI。そのままモデルへ渡せる。 */
	dataUrl: string;
	/** 実際に適用した正規化座標。モデルへ返して指定とのズレを気づかせる。 */
	applied: NormalizedBox;
	/** 切り出し後のピクセルサイズ(出力の縮小前)。 */
	source: { width: number; height: number };
}

/** 出力形式。JPEG に揃える(モデルへ渡すだけなので可逆性は不要)。 */
const OUTPUT_FORMAT = "image/jpeg" as const;

/**
 * 画像変換が使えるか(= `IMAGES` バインディングがあるか)。
 *
 * **無い環境でも解析そのものは通す**ための判定。バインディングの設定漏れで
 * エチケット解析が丸ごと落ちるより、拡大が使えないだけで済むほうが被害が小さい
 * (Workers AI へのフォールバックと同じ考え方)。呼び出し側は警告を出す。
 */
export function isImageTransformAvailable(): boolean {
	return !!(env as { IMAGES?: unknown }).IMAGES;
}

/** base64 の data URI を ReadableStream へ。Images バインディングはストリームを取る。 */
function toStream(dataUrl: string): ReadableStream<Uint8Array> {
	const { data } = parseImageDataUrl(dataUrl);
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
}

/** 変換結果の Response を data URI へ戻す。 */
async function toDataUrl(response: Response): Promise<string> {
	const buffer = await response.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	// btoa は引数長に上限があるので分割して積む(数MBの画像で落ちないように)。
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return `data:${OUTPUT_FORMAT};base64,${btoa(binary)}`;
}

/** 画像のピクセルサイズを得る。正規化座標をピクセルへ落とすのに要る。 */
async function imageSize(
	dataUrl: string,
): Promise<{ width: number; height: number }> {
	const info = await env.IMAGES.info(toStream(dataUrl));
	if (!("width" in info)) {
		// SVG はサイズを持たない。エチケット写真では起こらないが、型を絞るために弾く。
		throw new Error("画像のサイズを取得できませんでした");
	}
	return { width: info.width, height: info.height };
}

/**
 * 長辺を上限まで縮小する。**拡大はしない**(`scale-down`)。
 *
 * モデルへ最初に見せる版を作るのに使う。クロップ用の原寸をそのまま会話へ載せると
 * 入力トークンが毎ターン効いてくるため、見せる版と切る版を分ける。
 */
export async function downscaleImage(
	dataUrl: string,
	maxDimension: number,
): Promise<string> {
	const result = await env.IMAGES.input(toStream(dataUrl))
		.transform({ width: maxDimension, height: maxDimension, fit: "scale-down" })
		.output({ format: OUTPUT_FORMAT });
	return await toDataUrl(result.response());
}

/**
 * 指定領域を切り出す。**モデルの座標がずれていても壊れない**ように、幾何は
 * `resolveCropBox` が均してから渡す(最小サイズ・余白・画像範囲へのクランプ)。
 *
 * @param maxDimension 出力の長辺上限。切り出し結果がこれより小さければ拡大しない。
 */
export async function cropImage(
	dataUrl: string,
	box: NormalizedBox,
	maxDimension: number,
): Promise<CroppedImage> {
	const size = await imageSize(dataUrl);
	const resolved: CropResolution = resolveCropBox(box, size);
	const { pixels } = resolved;
	// trim は「各辺から削るピクセル数」+「残す幅・高さ」。resize より前に効く。
	const transform = {
		trim: {
			left: pixels.left,
			top: pixels.top,
			width: pixels.width,
			height: pixels.height,
		},
	} as const;
	const outputWidth = resolveOutputWidth(pixels, maxDimension);
	const result = await env.IMAGES.input(toStream(dataUrl))
		.transform(
			outputWidth === undefined
				? transform
				: { ...transform, width: outputWidth },
		)
		.output({ format: OUTPUT_FORMAT });
	return {
		dataUrl: await toDataUrl(result.response()),
		applied: resolved.applied,
		source: { width: pixels.width, height: pixels.height },
	};
}
