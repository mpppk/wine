import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	type AffiliateConfig,
	EMPTY_AFFILIATE_CONFIG,
	getProducerPurchaseLinks,
	getWineryPurchaseLinks,
	type PurchaseLinks,
} from "#/lib/wine/affiliate";
import type { AopAncestry } from "#/lib/wine/aop-tree";
import {
	GRAND_CRU_TAG_COLOR,
	KIND_COLORS,
	KIND_LABELS_JA,
} from "#/lib/wine/map-style";
import { formatAopTagJa } from "#/lib/wine/tags";
import { getBoundarySourceNoteJa } from "#/lib/wine/terminology";
import type { Aop, WineColor } from "#/lib/wine/types";
import { getVariety } from "#/lib/wine/varieties";

const COLOR_LABELS_JA: Record<WineColor, string> = {
	red: "赤",
	white: "白",
	rose: "ロゼ",
	sparkling: "泡",
	"sweet-white": "甘口白",
};

export function KindBadge({ aop }: { aop: Aop }) {
	// 特級タグ持ちは地図と同じく最濃色のドットで示す
	const color = aop.tags?.includes("grand-cru")
		? GRAND_CRU_TAG_COLOR
		: KIND_COLORS[aop.kind];
	const tagLabels = (aop.tags ?? []).map((t) => formatAopTagJa(aop, t));
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium"
			style={{ borderColor: color.line }}
		>
			<span
				aria-hidden
				className="size-2 rounded-full"
				style={{ backgroundColor: color.fill }}
			/>
			{[KIND_LABELS_JA[aop.kind], ...tagLabels].join(" / ")}
		</span>
	);
}

export function AopDetailPanel({
	aop,
	ancestry,
	onSelectAop,
	onPrev,
	onNext,
	position,
	onClose,
	compact = false,
	affiliate = EMPTY_AFFILIATE_CONFIG,
}: {
	aop: Aop;
	/** 所属する親(村名AOC・地区・地方)の情報。未指定なら所属セクションを表示しない */
	ancestry?: AopAncestry;
	/** 親の村名AOCをタップしたときの遷移先。未指定なら親はテキスト表示のみ */
	onSelectAop?: (aopId: string) => void;
	/** 前の同一区分AOPへ移動。undefined ならボタンを無効化(先頭) */
	onPrev?: () => void;
	/** 次の同一区分AOPへ移動。undefined ならボタンを無効化(末尾) */
	onNext?: () => void;
	/** 同一区分シーケンス内の位置。指定時は「n / total」を表示する */
	position?: { index: number; total: number };
	onClose?: () => void;
	/** embed用: 余白と文字量を切り詰める */
	compact?: boolean;
	/** アフィリエイトID。購入リンクの計測用ラップに使う。未指定なら素の検索リンク */
	affiliate?: AffiliateConfig;
}) {
	// 前後移動のいずれかが渡されたときだけナビ行を表示する
	const showNav = onPrev !== undefined || onNext !== undefined;
	const kindLabel = KIND_LABELS_JA[aop.kind];
	return (
		<div className={compact ? "space-y-2 p-3" : "space-y-3 p-4"}>
			{showNav && (
				<div className="flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onPrev}
						disabled={onPrev === undefined}
						aria-label={`前の${kindLabel}へ`}
						className="gap-1"
					>
						<ChevronLeftIcon className="size-4" />
						前へ
					</Button>
					{position && position.index >= 0 && (
						<span className="text-xs tabular-nums text-muted-foreground">
							{position.index + 1} / {position.total}
						</span>
					)}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onNext}
						disabled={onNext === undefined}
						aria-label={`次の${kindLabel}へ`}
						className="gap-1"
					>
						次へ
						<ChevronRightIcon className="size-4" />
					</Button>
				</div>
			)}
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h2 className="text-lg font-semibold leading-tight">{aop.nameJa}</h2>
					<p className="truncate text-sm text-muted-foreground">
						{aop.shortName}
					</p>
				</div>
				{onClose && (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={onClose}
						aria-label="閉じる"
						className="-mr-1 -mt-1 shrink-0"
					>
						<XIcon className="size-4" />
					</Button>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				<KindBadge aop={aop} />
				{aop.colors.map((c) => (
					<span
						key={c}
						className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
					>
						{COLOR_LABELS_JA[c]}
					</span>
				))}
			</div>

			{ancestry && (
				<AncestrySection ancestry={ancestry} onSelectAop={onSelectAop} />
			)}

			{!compact && <p className="text-sm leading-relaxed">{aop.description}</p>}

			<section>
				<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					ブドウ品種
				</h3>
				<ul className="flex flex-wrap gap-1.5">
					{aop.grapes.map((g) => {
						const v = getVariety(g.varietyId);
						return (
							<li
								key={g.varietyId}
								className={`rounded-md border px-2 py-0.5 text-xs ${
									g.role === "principal"
										? "border-foreground/30 font-medium"
										: "border-border text-muted-foreground"
								}`}
								title={g.role === "principal" ? "主要品種" : "補助品種"}
							>
								{v?.nameJa ?? g.varietyId}
								{g.role === "accessory" && "(補助)"}
							</li>
						);
					})}
				</ul>
			</section>

			<section>
				<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					土壌
				</h3>
				<p className="text-sm leading-relaxed">{aop.soil}</p>
			</section>

			<ProducersSection aop={aop} affiliate={affiliate} />

			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{getBoundarySourceNoteJa(aop)}
			</p>
		</div>
	);
}

// 主要な生産者のリストに購入リンク(アフィリエイト)を添えて表示する。
// winery(シャトー)の producers は所有者/運営体なのでリンクせず、
// 代わりにシャトー自体を検索する購入リンクを出す。
// アフィリエイトリンクを含むため、景品表示法(ステマ規制)対応の広告表記を伴う。
function ProducersSection({
	aop,
	affiliate,
}: {
	aop: Aop;
	affiliate: AffiliateConfig;
}) {
	const wineryLinks = getWineryPurchaseLinks(aop, affiliate);
	const rows = aop.producers.map((p) => ({
		producer: p,
		links: wineryLinks ? null : getProducerPurchaseLinks(p, affiliate),
	}));
	const hasLinks = wineryLinks !== null || rows.some((r) => r.links !== null);
	return (
		<section>
			<h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				主要な生産者
				{hasLinks && (
					<span className="rounded-sm border border-border px-1 py-px text-[10px] font-normal normal-case tracking-normal">
						PR
					</span>
				)}
			</h3>
			<ul className="list-inside list-disc text-sm leading-relaxed">
				{rows.map(({ producer, links }) => (
					<li key={producer.name}>
						{producer.name}
						{links && <PurchaseLinkPair name={producer.name} links={links} />}
					</li>
				))}
			</ul>
			{wineryLinks && (
				<p className="mt-1 text-sm leading-relaxed">
					このシャトーのワインを探す
					<PurchaseLinkPair name={aop.nameJa} links={wineryLinks} />
				</p>
			)}
			{hasLinks && (
				<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
					※「楽天」「Amazon」は広告リンク(アフィリエイト)です
				</p>
			)}
		</section>
	);
}

// ECサイトの検索結果へ飛ぶ購入リンクの組。広告リンクなので rel="sponsored" を付ける
function PurchaseLinkPair({
	name,
	links,
}: {
	name: string;
	links: PurchaseLinks;
}) {
	return (
		<span className="ml-1.5 inline-flex items-baseline gap-1.5 whitespace-nowrap">
			<a
				href={links.rakuten}
				target="_blank"
				rel="sponsored nofollow noopener"
				aria-label={`${name}のワインを楽天市場で探す`}
				className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
			>
				楽天
			</a>
			<a
				href={links.amazon}
				target="_blank"
				rel="sponsored nofollow noopener"
				aria-label={`${name}のワインをAmazonで探す`}
				className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
			>
				Amazon
			</a>
		</span>
	);
}

// 所属する親(村名AOC・地区・地方)を表示する。畑は複数村に
// またがることがあるため、親の村名AOCは複数並ぶことがある。
function AncestrySection({
	ancestry,
	onSelectAop,
}: {
	ancestry: AopAncestry;
	onSelectAop?: (aopId: string) => void;
}) {
	const { regionNameJa, subregionNameJa, villages } = ancestry;
	const regionPath = [subregionNameJa, regionNameJa]
		.filter(Boolean)
		.join(" ・ ");

	return (
		<section>
			<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				所属
			</h3>
			{villages.length > 0 && (
				<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">
						{villages.length > 1 ? "村名AOC(複数村にまたがる)" : "村名AOC"}
					</span>
					{villages.map((v) =>
						onSelectAop ? (
							<button
								key={v.id}
								type="button"
								onClick={() => onSelectAop(v.id)}
								className="rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted"
							>
								{v.nameJa}
							</button>
						) : (
							<span
								key={v.id}
								className="rounded-md border border-border px-2 py-0.5 text-xs font-medium"
							>
								{v.nameJa}
							</span>
						),
					)}
				</div>
			)}
			{regionPath && (
				<p className="text-sm text-muted-foreground">{regionPath}</p>
			)}
		</section>
	);
}
