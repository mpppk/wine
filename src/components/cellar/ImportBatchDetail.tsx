import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, StoreIcon, WineIcon } from "lucide-react";
import {
	WinePhotoGallery,
	ZoomablePhoto,
} from "#/components/cellar/WinePhotoGallery";
import { Button } from "#/components/ui/button";
import { formatDateTimeJst } from "#/lib/date/display";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import type { ImportBatchDetail } from "#/lib/services/drunk-wine-service";

// 一括登録バッチ1件の詳細(履歴の行からの遷移先)。**読み取り専用**——
// 分析完了後の一覧(レビューカード)と同等の項目を、保存済みの値から出す。
// 写真の表示は WinePhotoGallery / ZoomablePhoto に寄せる(タップで拡大・
// 切替の挙動と、先頭=代表の規則を wine-1 と揃えるため、ここで書き直さない)。
//
// 参考サイト・価格の一覧は保存していない(IMPL-3 はジョブ結果JSONにだけ載る)
// ため、ここには出ない。

function SectionHeading({ children }: { children: React.ReactNode }) {
	return <h2 className="text-sm font-medium">{children}</h2>;
}

function SightingLine({
	placeName,
	seenOn,
	price,
	memo,
	photoUrl,
	version,
}: {
	placeName: string | null;
	seenOn: string | null;
	price: number | null;
	memo: string | null;
	photoUrl: string | null;
	/** 写真のキャッシュバスタ。バッチの createdAt を渡す */
	version: number;
}) {
	return (
		<div className="flex items-start gap-3 text-sm">
			{photoUrl && (
				<ZoomablePhoto
					src={`${photoUrl}?v=${version}`}
					alt={`${placeName ?? "場所未設定"}で見かけたときの写真`}
					className="size-14"
				/>
			)}
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="font-medium">{placeName ?? "場所の指定なし"}</span>
				<span className="text-muted-foreground">
					{seenOn ?? "日付不明"}
					{price != null && ` / ${price.toLocaleString("ja-JP")}円`}
				</span>
				{memo && <p className="whitespace-pre-wrap break-words">{memo}</p>}
			</div>
		</div>
	);
}

export function ImportBatchDetailView({
	detail,
}: {
	detail: ImportBatchDetail;
}) {
	return (
		<main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
			<div className="flex items-center gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					aria-label="一括登録の履歴へ戻る"
				>
					<Link to="/cellar/import/history">
						<ArrowLeftIcon className="size-4" />
					</Link>
				</Button>
				<h1 className="text-2xl font-bold">一括登録の詳細</h1>
			</div>

			<div className="flex flex-col gap-1 text-sm">
				<p className="font-medium">
					{formatDateTimeJst(new Date(detail.createdAt))}
				</p>
				<p className="text-muted-foreground">
					{detail.placeName ?? "場所の指定なし"}
					{detail.seenOn && `・${detail.seenOn}に見かけた`}
				</p>
				<p className="text-muted-foreground">
					写真{detail.photoUrls.length}枚・新規{detail.createdEntries.length}件
					{detail.matchedSightings.length > 0 &&
						`・既存へ追加${detail.matchedSightings.length}件`}
				</p>
			</div>

			<section className="flex flex-col gap-3">
				<SectionHeading>アップロードした写真</SectionHeading>
				{detail.photoUrls.length > 0 ? (
					<WinePhotoGallery
						name="一括登録"
						photoUrls={detail.photoUrls}
						thumbUrls={detail.photoUrls}
						version={detail.createdAt}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						写真なしで登録されています。
					</p>
				)}
			</section>

			{detail.createdEntries.length > 0 && (
				<section className="flex flex-col gap-3">
					<SectionHeading>新規作成した銘柄</SectionHeading>
					<ul className="flex flex-col gap-3">
						{detail.createdEntries.map((entry) => (
							<li
								key={entry.id}
								className="flex flex-col gap-3 rounded-lg border border-border p-4"
							>
								<div className="flex items-center gap-2">
									<WineIcon
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<Link
										to="/cellar/$entryId"
										params={{ entryId: entry.id }}
										className="min-w-0 flex-1 truncate text-base font-medium underline decoration-dotted underline-offset-4 hover:decoration-solid"
									>
										{entry.name}
									</Link>
									<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
										{WINE_STATUS_LABELS_JA[entry.status]}
									</span>
								</div>
								{(entry.vintage !== null || entry.producer || entry.note) && (
									<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
										{entry.vintage !== null && (
											<>
												<dt className="text-muted-foreground">ヴィンテージ</dt>
												<dd>{entry.vintage}年</dd>
											</>
										)}
										{entry.producer && (
											<>
												<dt className="text-muted-foreground">生産者</dt>
												<dd className="break-words">{entry.producer}</dd>
											</>
										)}
										{entry.note && (
											<>
												<dt className="text-muted-foreground">コメント</dt>
												<dd className="whitespace-pre-wrap break-words">
													{entry.note}
												</dd>
											</>
										)}
									</dl>
								)}
								{entry.photoUrls.length > 0 && (
									<WinePhotoGallery
										name={entry.name}
										photoUrls={entry.photoUrls}
										thumbUrls={entry.thumbUrls}
										version={entry.updatedAt}
										photoKinds={entry.photoKinds}
									/>
								)}
								{entry.sighting && (
									<div className="flex flex-col gap-1 border-t border-border pt-3">
										<p className="text-xs text-muted-foreground">
											この登録で付けた見かけた記録
										</p>
										<SightingLine
											placeName={entry.sighting.placeName}
											seenOn={entry.sighting.seenOn}
											price={entry.sighting.price}
											memo={entry.sighting.memo}
											photoUrl={entry.sighting.photoUrl}
											version={detail.createdAt}
										/>
									</div>
								)}
							</li>
						))}
					</ul>
				</section>
			)}

			{detail.matchedSightings.length > 0 && (
				<section className="flex flex-col gap-3">
					<SectionHeading>既存へ追加した目撃記録</SectionHeading>
					<ul className="flex flex-col gap-3">
						{detail.matchedSightings.map((sighting) => (
							<li
								key={sighting.id}
								className="flex flex-col gap-2 rounded-lg border border-border p-4"
							>
								<div className="flex items-center gap-2 text-sm">
									<StoreIcon
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									{sighting.entryName ? (
										<Link
											to="/cellar/$entryId"
											params={{ entryId: sighting.entryId }}
											className="min-w-0 flex-1 truncate font-medium underline decoration-dotted underline-offset-4 hover:decoration-solid"
										>
											{sighting.entryName}
										</Link>
									) : (
										<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
											削除済みの銘柄
										</span>
									)}
								</div>
								<SightingLine
									placeName={sighting.placeName}
									seenOn={sighting.seenOn}
									price={sighting.price}
									memo={sighting.memo}
									photoUrl={sighting.photoUrl}
									version={detail.createdAt}
								/>
							</li>
						))}
					</ul>
				</section>
			)}

			{detail.createdEntries.length === 0 &&
				detail.matchedSightings.length === 0 && (
					<p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
						このバッチから残っている記録はありません。
					</p>
				)}
		</main>
	);
}
