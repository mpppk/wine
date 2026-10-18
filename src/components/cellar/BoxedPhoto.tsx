import { useCallback, useEffect, useRef, useState } from "react";
import {
	type PhotoBox,
	photoBoxFocusRect,
	photoBoxToPixels,
} from "#/lib/drunk-wine/photo-box";
import { cn } from "#/lib/utils";

// 写真に「その銘柄があった枠」を重ねて出す部品(Issue #693)。写真は焼き込まず、
// 保存してある枠の座標(0〜1 の比率。`photo-box.ts`)を表示時に重ねる。
//
// 2つの見せ方を持つ:
//  - `tile`: 正方形などのサムネイル。**枠の範囲へ寄せて**表示する(棚の写真では1本が
//    小さく、全体のままだとどの銘柄も同じサムネイルに見えるため)。寄せる領域は
//    画像のピクセル寸法から決めるので、読み込み後に寸法を測ってから重ねる
//  - `full`: 拡大表示。全体写真に枠を重ね、枠の外を暗くする。画像の表示寸法に
//    重ねるだけなので寸法を測らずに済む(正規化座標の SVG を画像に被せる)
//
// 枠が無い写真は素の <img> と同じ見た目になる(呼び出し側で分岐させない)。

/** 枠の外を暗くする濃さ。写真の文脈が残る程度に留める。 */
const DIM_OPACITY = 0.5;
/** 枠線の色。暗い写真でも明るい写真でも目立つ黄色に、黒の縁を付ける。 */
const BOX_STROKE = "#facc15";

/**
 * 枠線と枠外の暗転を描く。座標系は呼び出し側の viewBox(ピクセル or 正規化)。
 * 線幅は `vector-effect` で画面上のピクセルに固定する(拡大率に引きずられない)。
 */
function BoxOverlayShapes({
	rect,
	frame,
}: {
	rect: { x: number; y: number; width: number; height: number };
	frame: { x: number; y: number; width: number; height: number };
}) {
	// 外側の長方形から枠をくり抜いた形(evenodd)で枠の外だけを暗くする。
	const dim =
		`M${frame.x} ${frame.y}h${frame.width}v${frame.height}h${-frame.width}Z` +
		`M${rect.x} ${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`;
	return (
		<>
			<path d={dim} fill="black" fillOpacity={DIM_OPACITY} fillRule="evenodd" />
			<rect
				{...rect}
				fill="none"
				stroke="black"
				strokeOpacity={0.6}
				strokeWidth={4}
				vectorEffect="non-scaling-stroke"
			/>
			<rect
				{...rect}
				fill="none"
				stroke={BOX_STROKE}
				strokeWidth={2}
				vectorEffect="non-scaling-stroke"
			/>
		</>
	);
}

/** 正規化座標(0〜1)の枠を、表示中の画像にぴったり重ねる SVG。 */
export function PhotoBoxOverlay({
	box,
	className,
}: {
	box: PhotoBox;
	className?: string;
}) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 1 1"
			preserveAspectRatio="none"
			className={cn(
				"pointer-events-none absolute inset-0 size-full",
				className,
			)}
		>
			<BoxOverlayShapes
				rect={photoBoxToPixels(box, { width: 1, height: 1 })}
				frame={{ x: 0, y: 0, width: 1, height: 1 }}
			/>
		</svg>
	);
}

/** 読み込み済みの画像の寸法。SSR・キャッシュ済み画像の両方で取れるようにする。 */
function useNaturalSize(src: string) {
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	);
	const ref = useRef<HTMLImageElement | null>(null);
	const measure = useCallback((img: HTMLImageElement | null) => {
		if (img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
			setSize({ width: img.naturalWidth, height: img.naturalHeight });
		}
	}, []);
	// 写真が差し替わったら測り直す。キャッシュから即座に読み込まれた画像は
	// onLoad より先に complete になりうるので、その場でも一度測る。
	// biome-ignore lint/correctness/useExhaustiveDependencies: src の変化で測り直すのが目的
	useEffect(() => {
		setSize(null);
		measure(ref.current);
	}, [measure, src]);
	return {
		size,
		ref,
		onLoad: (e: React.SyntheticEvent<HTMLImageElement>) =>
			measure(e.currentTarget),
	};
}

export interface BoxedPhotoProps {
	src: string;
	alt: string;
	/** 重ねる枠。null なら素の写真 */
	box: PhotoBox | null | undefined;
	/** `tile` は枠へ寄せたサムネイル、`full` は全体写真+枠 */
	variant: "tile" | "full";
	/** 外枠の class。`tile` では大きさ(aspect-square 等)を呼び出し側が決める */
	className?: string;
	/** <img> の class(`full` で max-h などを決める) */
	imgClassName?: string;
	loading?: "lazy" | "eager";
	referrerPolicy?: "no-referrer";
}

export function BoxedPhoto({
	src,
	alt,
	box,
	variant,
	className,
	imgClassName,
	loading,
	referrerPolicy,
}: BoxedPhotoProps) {
	const { size, ref, onLoad } = useNaturalSize(src);
	const imgProps = {
		src,
		decoding: "async" as const,
		...(loading ? { loading } : {}),
		...(referrerPolicy ? { referrerPolicy } : {}),
	};

	if (variant === "full") {
		return (
			// 画像の表示寸法に外枠を合わせ(w-fit)、SVG を inset-0 で被せる。
			<div className={cn("relative mx-auto w-fit max-w-full", className)}>
				<img {...imgProps} alt={alt} className={cn("block", imgClassName)} />
				{box && <PhotoBoxOverlay box={box} />}
			</div>
		);
	}

	// tile: 寸法が分かるまでは素の object-cover で出し、分かったら枠へ寄せた SVG を被せる。
	const focus = box && size ? photoBoxFocusRect(box, size) : null;
	return (
		<div className={cn("relative overflow-hidden", className)}>
			<img
				{...imgProps}
				alt={alt}
				ref={ref}
				onLoad={onLoad}
				className={cn("size-full object-cover", imgClassName)}
			/>
			{box && size && focus && (
				<svg
					aria-hidden
					viewBox={`${focus.x} ${focus.y} ${focus.width} ${focus.height}`}
					// object-cover と同じ規則で、タイルの縦横比に合わせて切る。
					preserveAspectRatio="xMidYMid slice"
					className="pointer-events-none absolute inset-0 size-full"
				>
					<image
						href={src}
						width={size.width}
						height={size.height}
						preserveAspectRatio="none"
					/>
					<BoxOverlayShapes
						rect={photoBoxToPixels(box, size)}
						frame={{ x: 0, y: 0, width: size.width, height: size.height }}
					/>
				</svg>
			)}
		</div>
	);
}
