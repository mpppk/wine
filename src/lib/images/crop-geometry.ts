// モデルが指定した「拡大したい領域」を、実際に切り出せる範囲へ均す純ロジック。
//
// **モデルの座標精度に依存しない形にするのがこのモジュールの仕事**。実測では
// gpt-5.6-luna はラベルの位置を手作業の指定とほぼ同じ精度で指せたが、1枚での結果に
// 賭ける設計にはしない。狭すぎる指定を広げ、余白を足し、画像からはみ出した枠を
// 収めることで、多少ずれても「読みたい文字が枠外に落ちる」事故を避ける。
//
// 外した回の損失も小さくしてある: このツールは自前の変換だけで完結する(web検索の
// ような回数課金が無い)ので、やり直しは1ターンぶんのトークンで済む。実際に適用した
// 枠は結果として返すので、モデルは自分の指定とのズレを見て次の指定を直せる。

/** モデルが指定する領域。画像の左上を (0,0)、右下を (1,1) とする正規化座標。 */
export interface NormalizedBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** 実際に切り出すピクセル範囲。 */
export interface PixelBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CropResolution {
	/** 切り出すピクセル範囲。 */
	pixels: PixelBox;
	/** 実際に適用した正規化座標。モデルへ返してズレを気づかせる。 */
	applied: NormalizedBox;
}

/**
 * 切り出す領域の最小の大きさ(正規化)。
 *
 * これより狭い指定は中心を保ったまま広げる。狭すぎる指定は「読みたい文字の一部しか
 * 入らない」形で失敗しやすく、しかもその失敗はモデルからは「文字が途切れている」と
 * しか見えないため原因を掴みにくい。広すぎる方向の失敗(倍率が足りない)は、
 * モデルが自分で狭め直せるので回復しやすい。
 */
export const CROP_MIN_SIZE = 0.1;

/** 指定枠の周囲に足す余白(正規化)。境界ぎりぎりの文字が切れるのを防ぐ。 */
export const CROP_PADDING = 0.02;

/** 値を [min, max] に収める。 */
function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * 1軸ぶんの開始位置と長さを、最小長・余白・画像範囲を考慮して決める。
 *
 * **はみ出したときは縮めずにずらす**。縮めると倍率が上がって読みたい範囲が枠外に
 * 出るが、ずらすだけなら入る可能性が残る(ずらしきれない場合だけ縮める)。
 */
function resolveAxis(
	start: number,
	length: number,
	minSize: number,
	padding: number,
): { start: number; length: number } {
	// 非有限・負の長さは「指定なし」と同じ扱いにして全体を返す(throw しない —— ここで
	// 落とすと、モデルの数値の書き損じで解析そのものが失敗する)。
	const safeStart = Number.isFinite(start) ? start : 0;
	const safeLength = Number.isFinite(length) && length > 0 ? length : 1;

	const center = safeStart + safeLength / 2;
	const padded = Math.max(safeLength + padding * 2, minSize);
	const clampedLength = Math.min(padded, 1);
	// 中心を保って配置し、はみ出したぶんはずらして収める。
	const rawStart = center - clampedLength / 2;
	return {
		start: clamp(rawStart, 0, 1 - clampedLength),
		length: clampedLength,
	};
}

/**
 * 正規化座標の指定を、画像サイズに対する実際の切り出し範囲へ解決する。
 *
 * @param box モデルが指定した領域
 * @param image 元画像のピクセルサイズ
 */
export function resolveCropBox(
	box: NormalizedBox,
	image: { width: number; height: number },
	options: { minSize?: number; padding?: number } = {},
): CropResolution {
	const minSize = options.minSize ?? CROP_MIN_SIZE;
	const padding = options.padding ?? CROP_PADDING;

	const x = resolveAxis(box.x, box.width, minSize, padding);
	const y = resolveAxis(box.y, box.height, minSize, padding);

	// ピクセルへ落とす。丸めで 0 幅にならないよう最低1pxを保証する。
	const left = Math.round(x.start * image.width);
	const top = Math.round(y.start * image.height);
	const width = Math.max(
		1,
		Math.min(Math.round(x.length * image.width), image.width - left),
	);
	const height = Math.max(
		1,
		Math.min(Math.round(y.length * image.height), image.height - top),
	);

	return {
		pixels: { left, top, width, height },
		applied: {
			x: x.start,
			y: y.start,
			width: x.length,
			height: y.length,
		},
	};
}

/**
 * 切り出した画像の出力サイズ(長辺)を決める。**拡大はしない**。
 *
 * 元より大きくしても情報は増えず、入力トークンだけが増える。切り出しで画角に占める
 * 割合が上がること自体が「拡大」の実体で、画素を水増しする必要はない。
 */
export function resolveOutputWidth(
	pixels: PixelBox,
	maxDimension: number,
): number | undefined {
	const longSide = Math.max(pixels.width, pixels.height);
	if (longSide <= maxDimension) return undefined;
	const scale = maxDimension / longSide;
	return Math.max(1, Math.round(pixels.width * scale));
}
