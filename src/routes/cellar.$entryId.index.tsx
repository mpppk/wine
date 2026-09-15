import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	MapIcon,
	PencilIcon,
	StoreIcon,
	WineIcon,
} from "lucide-react";
import { RatingStars } from "#/components/cellar/RatingStars";
import {
	PriceList,
	ReferenceLinksList,
} from "#/components/cellar/ReferenceLinksList";
import {
	WinePhotoGallery,
	ZoomablePhoto,
} from "#/components/cellar/WinePhotoGallery";
import {
	buildWineDetailRows,
	type WineDetailRow,
} from "#/components/cellar/wine-detail";
import { Button } from "#/components/ui/button";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import type { WineEncounterEntry } from "#/lib/services/drunk-wine-service";
import { getDrunkWine, listWineEncounters } from "#/server/drunk-wine";

// マイセラーの銘柄を選んだときに最初に出る閲覧専用の画面。編集画面
// (/cellar/$entryId/edit)は「編集」ボタンからの明示的な遷移にする。
//
// 一覧・地図・AOP詳細からのリンク先はすべてこの画面に向ける。編集フォームは
// 入力欄が縦に長く、離脱ガード(UnsavedChangesGuard)も持つため、「どんなワイン
// だったか見たいだけ」の用途には重い。
export const Route = createFileRoute("/cellar/$entryId/")({
	beforeLoad: requireAuthBeforeLoad,
	loader: async ({ params }) => {
		try {
			const [entry, encounters] = await Promise.all([
				getDrunkWine({ data: { id: params.entryId } }),
				listWineEncounters({ data: { drunkWineId: params.entryId } }),
			]);
			return { entry, encounters };
		} catch (e) {
			// 存在しない/他ユーザのエントリは一覧へ逃がす(編集画面と同じ扱い)。
			// それ以外(一時障害等)は握りつぶさずエラー表示に任せる
			if (e instanceof Error && e.message.includes("Entry not found")) {
				throw redirect({ to: "/cellar" });
			}
			throw e;
		}
	},
	component: CellarDetailPage,
});

function SectionHeading({ children }: { children: React.ReactNode }) {
	return <h2 className="text-sm font-medium">{children}</h2>;
}

function EmptySection({
	icon: Icon,
	children,
}: {
	icon: typeof WineIcon;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-6">
			<Icon className="size-6 text-muted-foreground/40" aria-hidden />
			<p className="text-sm text-muted-foreground">{children}</p>
		</div>
	);
}

/**
 * 体験記録の時系列(Issue #606)。飲んだ回と見かけただけの回を `occurred_on`
 * 降順の1本に混ぜる(ローダーの listWineEncounters がその順で返す)。
 * 飲んだ回は WineIcon + 評価、見かけただけは StoreIcon で出し分ける。
 */
function EncounterSection({
	encounters,
	version,
}: {
	encounters: WineEncounterEntry[];
	/** 写真のキャッシュバスタ。エントリの updatedAt を渡す */
	version: number;
}) {
	return (
		<section className="flex flex-col gap-3">
			<SectionHeading>記録</SectionHeading>
			{encounters.length === 0 ? (
				<EmptySection icon={WineIcon}>まだ記録がありません。</EmptySection>
			) : (
				<ul className="flex flex-col gap-2">
					{encounters.map((encounter) => (
						<li
							key={encounter.id}
							className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
						>
							{encounter.photoUrls.length > 0 && (
								// 由来の写真(ワインリスト/棚。対応写真のすべて)。
								// サムネイルは保存していないので原寸を読む
								// (編集画面の体験記録と同じ扱い)
								<div className="flex shrink-0 gap-1">
									{encounter.photoUrls.map((photoUrl) => (
										<ZoomablePhoto
											key={photoUrl}
											src={`${photoUrl}?v=${version}`}
											alt={`${encounter.placeName ?? "場所未設定"}で出会ったときの写真`}
											className="size-14"
										/>
									))}
								</div>
							)}
							<div className="flex min-w-0 flex-col gap-1">
								<span className="flex items-center gap-1 font-medium">
									{encounter.drank ? (
										<WineIcon
											className="size-3.5 text-muted-foreground"
											aria-hidden
										/>
									) : (
										<StoreIcon
											className="size-3.5 text-muted-foreground"
											aria-hidden
										/>
									)}
									{encounter.placeName ??
										(encounter.drank ? "飲んだ" : "場所未設定")}
								</span>
								{encounter.drank && encounter.rating !== null && (
									<RatingStars rating={encounter.rating} />
								)}
								<span className="text-muted-foreground">
									{encounter.occurredOn ?? "日付不明"}
									{encounter.price != null &&
										` / ${encounter.price.toLocaleString("ja-JP")}円`}
								</span>
								{encounter.memo && (
									<p className="whitespace-pre-wrap">{encounter.memo}</p>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * 属性1行ぶんの値。産地(地域・AOP)の行だけは産地の学習地図へのリンクにする。
 * これまで「このワインの産地がどこか」を地図で確かめるには、地域を選び直して目当ての
 * AOPを自分で探し当てる必要があった。AOP付きの行は地図側がポリゴンへズームし、詳細
 * パネル(区分・品種・格付け・関連クイズ・同じAOPの他の登録ワイン)まで開いた状態で
 * 着地する。
 *
 * リンクにするかどうかは buildWineDetailRows が決める(マスタから消えたAOP・準備中の
 * 地域は link を持たない)。ここは link の有無だけを見る。
 *
 * アイコンは inline に流す。inline-flex にすると産地名が折り返したときにアイコンが
 * 行全体の中央に浮くため(AOP名は「サンテミリオン・グラン・クリュ」等それなりに長い)。
 */
function DetailValue({ row }: { row: WineDetailRow }) {
	if (!row.link) return row.value;
	return (
		<Link
			to="/map/$regionId"
			params={{ regionId: row.link.regionId }}
			search={{ aop: row.link.aopId }}
			// リンク文言は産地名だけなので、読み上げでは行き先まで言い切る
			aria-label={`${row.value}を地図で見る`}
			className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
		>
			{row.value}
			<MapIcon
				className="ml-1 inline size-3.5 align-[-0.2em] text-muted-foreground"
				aria-hidden
			/>
		</Link>
	);
}

function CellarDetailPage() {
	const { entry, encounters } = Route.useLoaderData();
	const rows = buildWineDetailRows(entry);

	return (
		<main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
			<div className="flex items-start gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					className="shrink-0"
					aria-label="マイセラーへ戻る"
				>
					<Link to="/cellar">
						<ArrowLeftIcon className="size-4" />
					</Link>
				</Button>
				<div className="min-w-0 flex-1">
					<h1 className="text-2xl font-bold break-words">{entry.name}</h1>
					<p className="text-sm text-muted-foreground">
						{WINE_STATUS_LABELS_JA[entry.status]}
					</p>
				</div>
				<Button asChild size="sm" className="shrink-0">
					<Link to="/cellar/$entryId/edit" params={{ entryId: entry.id }}>
						<PencilIcon className="size-4" aria-hidden />
						編集
					</Link>
				</Button>
			</div>

			<WinePhotoGallery
				name={entry.name}
				photoUrls={entry.photoUrls}
				thumbUrls={entry.thumbUrls}
				version={entry.updatedAt}
				photoKinds={entry.photoKinds}
			/>

			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
				{rows.map((row) => (
					<div key={row.label} className="contents">
						<dt className="text-muted-foreground">{row.label}</dt>
						<dd className="break-words">
							<DetailValue row={row} />
						</dd>
					</div>
				))}
			</dl>

			{/*
			 * 銘柄のコメント(#471)。属性の定義リストではなく独立したセクションにするのは、
			 * 数行の文章で改行を保って読ませたいため(dl の1行に入れると他の属性の行送りに
			 * 引きずられる)。
			 */}
			{entry.note && (
				<section className="flex flex-col gap-3">
					<SectionHeading>コメント</SectionHeading>
					<p className="text-sm whitespace-pre-wrap break-words">
						{entry.note}
					</p>
				</section>
			)}

			{/*
			 * 解析の参考サイト・市場価格。銘柄に属する参考情報で、カードの展開部・
			 * 差分ダイアログと同じ共通コンポーネントから出す(表示のドリフト防止)。
			 */}
			{entry.referenceLinks.length > 0 && (
				<ReferenceLinksList links={entry.referenceLinks} />
			)}
			{entry.prices.length > 0 && <PriceList prices={entry.prices} />}

			<EncounterSection encounters={encounters} version={entry.updatedAt} />
		</main>
	);
}
