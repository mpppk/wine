import { WineIcon } from "lucide-react";
import { useState } from "react";
import { PhotoLightbox } from "#/components/cellar/PhotoLightbox";
import { cn } from "#/lib/utils";

// マイセラー閲覧画面の写真一覧。タップすると PhotoLightbox で拡大する。
//
// 一覧に出すのはサムネイル(thumbUrls)、拡大は原寸(photoUrls)。thumbUrls は
// photoUrls と同じ順・同じ長さで、実体が無い写真は配信ルートが原寸へフォールバック
// する(#237)。表示順の先頭が代表。

export interface WinePhotoGalleryProps {
	/** 銘柄名。写真の alt と拡大ダイアログの名前に使う */
	name: string;
	/** 原寸の相対URL(表示順) */
	photoUrls: string[];
	/** サムネイルの相対URL(photoUrls と同じ順・同じ長さ) */
	thumbUrls: string[];
	/** キャッシュバスタ。エントリの updatedAt を渡す(写真差し替え時にR2キーが同じでも再取得させる) */
	version: number;
}

export function WinePhotoGallery({
	name,
	photoUrls,
	thumbUrls,
	version,
}: WinePhotoGalleryProps) {
	const [openIndex, setOpenIndex] = useState<number | null>(null);

	if (photoUrls.length === 0) {
		return (
			<div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-border">
				<WineIcon className="size-10 text-muted-foreground/40" aria-hidden />
				<span className="sr-only">写真はありません</span>
			</div>
		);
	}

	return (
		<>
			<ul
				className={cn(
					"grid gap-2",
					// 1枚だけのときに画面幅いっぱいのタイルにすると間延びするので、
					// 代表写真として程よい大きさに留める
					photoUrls.length === 1
						? "max-w-xs grid-cols-1"
						: "grid-cols-3 sm:grid-cols-4",
				)}
			>
				{photoUrls.map((url, i) => (
					<li key={url}>
						<button
							type="button"
							onClick={() => setOpenIndex(i)}
							aria-label={`${name}の写真${i + 1}を拡大`}
							className="block w-full overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
						>
							<img
								src={`${thumbUrls[i] ?? url}?v=${version}`}
								alt=""
								className="aspect-square w-full object-cover"
								loading="lazy"
								decoding="async"
							/>
						</button>
					</li>
				))}
			</ul>

			<PhotoLightbox
				photos={photoUrls.map((url, i) => ({
					src: `${url}?v=${version}`,
					alt: `${name}の写真${i + 1}`,
				}))}
				openIndex={openIndex}
				onOpenChange={setOpenIndex}
				title={`${name}の写真`}
			/>
		</>
	);
}

/**
 * 1枚だけを拡大できるサムネイル。目撃記録の由来写真のように、銘柄の写真一覧とは
 * 別の文脈で1枚だけ並ぶ画像に使う(拡大の挙動は写真一覧と揃える)。
 */
export function ZoomablePhoto({
	src,
	alt,
	className,
}: {
	src: string;
	alt: string;
	className?: string;
}) {
	const [openIndex, setOpenIndex] = useState<number | null>(null);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpenIndex(0)}
				aria-label={`${alt}を拡大`}
				className={cn(
					"shrink-0 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80",
					className,
				)}
			>
				<img
					src={src}
					alt=""
					className="size-full object-cover"
					loading="lazy"
					decoding="async"
				/>
			</button>
			<PhotoLightbox
				photos={[{ src, alt }]}
				openIndex={openIndex}
				onOpenChange={setOpenIndex}
				title={alt}
			/>
		</>
	);
}
