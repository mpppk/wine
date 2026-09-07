import { WineIcon } from "lucide-react";
import { useState } from "react";
import { PhotoLightbox } from "#/components/cellar/PhotoLightbox";
import { WebPhotoBadge } from "#/components/cellar/WebPhotoBadge";
import type { PhotoKind } from "#/lib/ai/wine-list-extraction";
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
	/**
	 * 写真ごとの由来(photoUrls と同じ順・同じ長さ。IMPL-4)。`"web"` の写真にだけ
	 * 左上の overlay を出す。由来が分からない呼び出し元(保存済みエントリの表示
	 * など。永続化は由来カラムの追加後に配線する)は省略し、その場合は overlay
	 * を出さない。
	 */
	photoKinds?: readonly PhotoKind[];
}

export function WinePhotoGallery({
	name,
	photoUrls,
	thumbUrls,
	version,
	photoKinds,
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
							aria-label={`${name}の写真${i + 1}${photoKinds?.[i] === "web" ? "(WEB画像)" : ""}を拡大`}
							className="relative block w-full overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80"
						>
							<img
								src={`${thumbUrls[i] ?? url}?v=${version}`}
								alt=""
								className="aspect-square w-full object-cover"
								loading="lazy"
								decoding="async"
							/>
							{photoKinds?.[i] === "web" && <WebPhotoBadge variant="overlay" />}
						</button>
					</li>
				))}
			</ul>

			<PhotoLightbox
				photos={photoUrls.map((url, i) => ({
					src: `${url}?v=${version}`,
					alt: `${name}の写真${i + 1}${photoKinds?.[i] === "web" ? "(WEB画像)" : ""}`,
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
	/** WEB由来の画像なら左上に overlay を出し、由来を名前に含める(IMPL-4) */
	isWebPhoto,
	/**
	 * 外部URLのサムネイル(レビューカードの web 画像など)を出すときだけ付ける。
	 * 取得先へ Referer を送らない。
	 */
	referrerPolicy,
}: {
	src: string;
	alt: string;
	className?: string;
	isWebPhoto?: boolean;
	referrerPolicy?: "no-referrer";
}) {
	const [openIndex, setOpenIndex] = useState<number | null>(null);
	const label = isWebPhoto ? `${alt}(WEB画像)` : alt;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpenIndex(0)}
				aria-label={`${label}を拡大`}
				className={cn(
					"relative shrink-0 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80",
					className,
				)}
			>
				<img
					src={src}
					alt=""
					className="size-full object-cover"
					loading="lazy"
					decoding="async"
					{...(referrerPolicy ? { referrerPolicy } : {})}
				/>
				{isWebPhoto && <WebPhotoBadge variant="overlay" />}
			</button>
			<PhotoLightbox
				photos={[{ src, alt: label }]}
				openIndex={openIndex}
				onOpenChange={setOpenIndex}
				title={label}
			/>
		</>
	);
}
