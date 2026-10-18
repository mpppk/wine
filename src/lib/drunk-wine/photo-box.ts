import { z } from "zod";

// 写真の中で「その銘柄がどこにあったか」を示す枠(Issue #693)の域内SSOT。
//
// 一括登録の写真(ワインリスト・棚)には何本も写っているので、全体写真をそのまま
// 銘柄の写真にすると、どの銘柄でも同じ写真になる。解析ジョブが Jev の Box で枠を
// 求め、**写真は焼き込まずに座標だけを保存して表示時に重ねる**(元の写真を劣化させず、
// レビュー画面で直した枠をそのまま使えるようにするため)。
//
// 座標は Jev の Box と同じく**画像の左上を原点とした 0〜1 の比率で4辺**を持つ
// (`left`/`right` は幅、`top`/`bottom` は高さに対する比率)。縮小・サムネイル化しても
// 比率は変わらないので、原寸・サムネイルのどちらにも同じ値で重ねられる。
//
// zod のみに依存するリーフに保つ(`place/schema.ts` の入力スキーマから合成し、
// クライアントの表示部品からも読むため)。

/** 写真の中の1領域。4辺とも 0〜1 の比率で、`top < bottom`・`left < right`。 */
export interface PhotoBox {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/** バッチ写真の番号と、その写真の中の枠。体験記録が写真ごとに持つ。 */
export interface PhotoBoxEntry {
	/** バッチ写真の番号(0始まり)。体験記録の `photoIndexes` と同じ番号体系 */
	photoIndex: number;
	box: PhotoBox;
}

/**
 * 枠の最小の幅・高さ(比率)。これより狭い枠は「点」で、重ねても何も示さない。
 * レビュー画面のエディタもこれ未満には縮めさせない。
 */
export const PHOTO_BOX_MIN_SIZE = 0.02;

/**
 * 保存時の丸め桁。原寸 4000px でも 0.4px 単位で足りる。JSON を短く保つため
 * (1体験記録に最大10枚ぶん載る)。
 */
const PHOTO_BOX_DECIMALS = 4;

const edge = z.number().finite().min(0).max(1);

/** API境界(一括登録の入力)で受ける枠の形。正規化前の値は受けない。 */
export const photoBoxSchema = z
	.object({ top: edge, bottom: edge, left: edge, right: edge })
	.refine(
		(box) =>
			box.bottom - box.top >= PHOTO_BOX_MIN_SIZE - 1e-9 &&
			box.right - box.left >= PHOTO_BOX_MIN_SIZE - 1e-9,
		{ message: "枠が小さすぎるか、辺の向きが逆です" },
	);

/**
 * 写真番号つきの枠の一覧。`maxPhotoIndex` は写真番号の上限(含む)で、
 * 一括登録の写真上限から渡す(このリーフは place/schema の定数を import しない)。
 */
export function photoBoxEntriesSchema(maxPhotoIndex: number) {
	return z
		.array(
			z.object({
				photoIndex: z.number().int().min(0).max(maxPhotoIndex),
				box: photoBoxSchema,
			}),
		)
		.max(maxPhotoIndex + 1)
		.refine(
			(entries) =>
				new Set(entries.map((entry) => entry.photoIndex)).size ===
				entries.length,
			{ message: "同じ写真に枠が2つあります" },
		);
}

function round(value: number): number {
	const factor = 10 ** PHOTO_BOX_DECIMALS;
	return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * 任意の値を枠へ正規化する。**決して throw しない**(モデルの出力・DB の JSON・
 * 旧行のどれを渡してもよい)。
 *
 * - 範囲外は 0〜1 に収め、辺の向きが逆なら入れ替える(Jev の出力の揺れを吸収する)
 * - 数値でない・収めた結果が `PHOTO_BOX_MIN_SIZE` 未満なら null
 */
export function normalizePhotoBox(value: unknown): PhotoBox | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const nums = [raw.top, raw.bottom, raw.left, raw.right];
	if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
		return null;
	}
	const [t, b, l, r] = (nums as number[]).map(clamp01) as [
		number,
		number,
		number,
		number,
	];
	const box = {
		top: round(Math.min(t, b)),
		bottom: round(Math.max(t, b)),
		left: round(Math.min(l, r)),
		right: round(Math.max(l, r)),
	};
	if (
		box.bottom - box.top < PHOTO_BOX_MIN_SIZE ||
		box.right - box.left < PHOTO_BOX_MIN_SIZE
	) {
		return null;
	}
	return box;
}

/**
 * 写真番号つきの枠の一覧を正規化する(DB の JSON・解析結果の読み取り用)。
 * 番号が整数でない・`photoCount` の範囲外・枠が壊れている行は落とし、同じ番号は
 * 先勝ちで1つにして番号順に並べる。決して throw しない。
 */
export function normalizePhotoBoxEntries(
	value: unknown,
	photoCount?: number,
): PhotoBoxEntry[] {
	if (!Array.isArray(value)) return [];
	const byIndex = new Map<number, PhotoBox>();
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const { photoIndex, box } = raw as Record<string, unknown>;
		if (typeof photoIndex !== "number" || !Number.isInteger(photoIndex)) {
			continue;
		}
		if (photoIndex < 0) continue;
		if (photoCount !== undefined && photoIndex >= photoCount) continue;
		if (byIndex.has(photoIndex)) continue;
		const normalized = normalizePhotoBox(box);
		if (normalized) byIndex.set(photoIndex, normalized);
	}
	return [...byIndex.entries()]
		.sort(([a], [b]) => a - b)
		.map(([photoIndex, box]) => ({ photoIndex, box }));
}

/** 写真番号に対応する枠。無ければ null。 */
export function photoBoxForIndex(
	entries: readonly PhotoBoxEntry[] | null | undefined,
	photoIndex: number,
): PhotoBox | null {
	return entries?.find((entry) => entry.photoIndex === photoIndex)?.box ?? null;
}

/** 写真番号の枠を差し替える(null で外す)。番号順は保つ。 */
export function setPhotoBoxForIndex(
	entries: readonly PhotoBoxEntry[],
	photoIndex: number,
	box: PhotoBox | null,
): PhotoBoxEntry[] {
	const rest = entries.filter((entry) => entry.photoIndex !== photoIndex);
	if (!box) return rest;
	return [...rest, { photoIndex, box }].sort(
		(a, b) => a.photoIndex - b.photoIndex,
	);
}

/** 画像のピクセル座標での矩形(SVG の viewBox と同じ並び)。 */
export interface PixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** 枠をピクセル座標へ落とす。 */
export function photoBoxToPixels(
	box: PhotoBox,
	size: { width: number; height: number },
): PixelRect {
	return {
		x: box.left * size.width,
		y: box.top * size.height,
		width: (box.right - box.left) * size.width,
		height: (box.bottom - box.top) * size.height,
	};
}

/**
 * サムネイルで「枠の範囲へ寄せて」表示するときの表示領域(ピクセル座標)。
 *
 * 棚の写真では1本が小さいので、全体のままだとどの銘柄も同じサムネイルに見える。
 * 枠の周囲に `padding`(枠の幅・高さに対する比率)の余白を足し、タイルの縦横比
 * `aspect`(幅/高さ)に合わせて広げた領域を返す。
 *
 * - 画像からはみ出すときは**縮めずにずらす**(枠が欠けないように)
 * - 画像より大きくなるときは画像の大きさまでに収める(残りは表示側の
 *   `preserveAspectRatio="slice"` が `object-cover` と同じ規則で切る)
 */
export function photoBoxFocusRect(
	box: PhotoBox,
	size: { width: number; height: number },
	aspect = 1,
	padding = 0.25,
): PixelRect {
	const px = photoBoxToPixels(box, size);
	const paddedWidth = px.width * (1 + padding * 2);
	const paddedHeight = px.height * (1 + padding * 2);
	let width = Math.max(paddedWidth, paddedHeight * aspect);
	let height = width / aspect;
	const fit = Math.min(1, size.width / width, size.height / height);
	width *= fit;
	height *= fit;
	const centerX = px.x + px.width / 2;
	const centerY = px.y + px.height / 2;
	const x = Math.min(Math.max(centerX - width / 2, 0), size.width - width);
	const y = Math.min(Math.max(centerY - height / 2, 0), size.height - height);
	return { x, y, width, height };
}

// ---- レビュー画面の枠エディタの幾何(#693) ----
// ドラッグ・キー操作の結果を、常に有効な枠(画像内・最小サイズ以上)へ収める。

/** 「枠を追加」で置く既定の枠。中央に、画像の 40% 四方。 */
export function defaultPhotoBox(): PhotoBox {
	return { top: 0.3, bottom: 0.7, left: 0.3, right: 0.7 };
}

/**
 * 枠を大きさを保ったまま動かす。画像からはみ出す分は**縮めずに止める**
 * (端へ寄せたら大きさが変わっていた、を起こさない)。
 */
export function movePhotoBox(box: PhotoBox, dx: number, dy: number): PhotoBox {
	const width = box.right - box.left;
	const height = box.bottom - box.top;
	const left = Math.min(Math.max(box.left + dx, 0), 1 - width);
	const top = Math.min(Math.max(box.top + dy, 0), 1 - height);
	return {
		top: round(top),
		bottom: round(top + height),
		left: round(left),
		right: round(left + width),
	};
}

/** 枠の角。リサイズの取っ手の位置。 */
export type PhotoBoxCorner =
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

/**
 * 角をつまんで (x, y) へ動かす。向かいの角は動かさず、画像の範囲と最小サイズ
 * (`PHOTO_BOX_MIN_SIZE`)に収める(角を向かいの角の反対側まで引っ張っても裏返らない)。
 */
export function resizePhotoBox(
	box: PhotoBox,
	corner: PhotoBoxCorner,
	x: number,
	y: number,
): PhotoBox {
	const cx = clamp01(x);
	const cy = clamp01(y);
	const next = { ...box };
	if (corner === "top-left" || corner === "bottom-left") {
		next.left = Math.min(cx, box.right - PHOTO_BOX_MIN_SIZE);
	} else {
		next.right = Math.max(cx, box.left + PHOTO_BOX_MIN_SIZE);
	}
	if (corner === "top-left" || corner === "top-right") {
		next.top = Math.min(cy, box.bottom - PHOTO_BOX_MIN_SIZE);
	} else {
		next.bottom = Math.max(cy, box.top + PHOTO_BOX_MIN_SIZE);
	}
	return {
		top: round(next.top),
		bottom: round(next.bottom),
		left: round(next.left),
		right: round(next.right),
	};
}

/**
 * 右下の角を (dw, dh) だけ広げる/縮める(キー操作のリサイズ)。
 * 画像の範囲と最小サイズに収める。
 */
export function growPhotoBox(box: PhotoBox, dw: number, dh: number): PhotoBox {
	return resizePhotoBox(box, "bottom-right", box.right + dw, box.bottom + dh);
}
