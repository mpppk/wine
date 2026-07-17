import {
	ArrowLeftIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	GraduationCapIcon,
	XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { cn } from "#/lib/utils";
import {
	type AffiliateConfig,
	EMPTY_AFFILIATE_CONFIG,
	getProducerPurchaseLinks,
	getWineryPurchaseLinks,
	type PurchaseLinks,
} from "#/lib/wine/affiliate";
import type { AopAncestry } from "#/lib/wine/aop-tree";
import { buildDescriptionSegments } from "#/lib/wine/description-links";
import {
	GRAND_CRU_TAG_COLOR,
	KIND_COLORS,
	KIND_LABELS_JA,
} from "#/lib/wine/map-style";
import {
	getProducerInfo,
	MICHELIN_GRAPES_ARTICLE_URL,
	type ProducerInfo,
} from "#/lib/wine/producer-info";
import {
	classificationPanelBadgeJa,
	isLegalAppellation,
} from "#/lib/wine/tags";
import {
	getAppellationBadgeJa,
	getBoundarySourceNoteJa,
	getVineyardTermJa,
} from "#/lib/wine/terminology";
import type { Aop, Region, WineColor } from "#/lib/wine/types";
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
	// 畑(vineyard)区分は地域固有の呼称(ブルゴーニュ=クリマ/アルザス=リュー・ディ)で示す
	const kindLabel =
		aop.kind === "vineyard"
			? getVineyardTermJa(aop.region)
			: KIND_LABELS_JA[aop.kind];
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
			{kindLabel}
		</span>
	);
}

/**
 * 格付け(特級/一級/DOCG/第1級(1855)/A 等)を AOC バッジと同じ淡色バッジで示す。
 * 格付けを持たない AOP(およびブルゴーニュ村名の「1er Cru 区画あり」)は何も出さない。
 */
function ClassificationBadge({ aop }: { aop: Aop }) {
	const label = classificationPanelBadgeJa(aop);
	if (!label) return null;
	return (
		<span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
			{label}
		</span>
	);
}

/**
 * 法的に独立したアペラシオンか否かを示すバッジ。「クリマである」ことと「AOCで
 * ある」ことは直交するため、kind ではなく isLegalAppellation で判定する。
 */
function AppellationBadge({ aop }: { aop: Aop }) {
	if (isLegalAppellation(aop)) {
		return (
			<span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
				{getAppellationBadgeJa(aop.region)}
			</span>
		);
	}
	return (
		<span className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
			非AOC
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
	closeButtonClassName,
	compact = false,
	quizQuestionCount,
	onStartQuiz,
	affiliate = EMPTY_AFFILIATE_CONFIG,
	aops,
	regions,
	onSelectRegion,
	onBack,
	backToName,
	referenceLinksSlot,
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
	/** 閉じるボタンの表示制御用の追加class。embedでモバイル時に隠す等に使う */
	closeButtonClassName?: string;
	/** embed用: 余白と文字量を切り詰める */
	compact?: boolean;
	/** このAOPを起点に出題できる問題数。0ならクイズボタンを出さない */
	quizQuestionCount?: number;
	/** クイズ開始。未指定ならクイズボタンを出さない(embed等) */
	onStartQuiz?: () => void;
	/** アフィリエイトID。購入リンクの計測用ラップに使う。未指定なら素の検索リンク */
	affiliate?: AffiliateConfig;
	/**
	 * 説明文中の他AOP名をリンク化するための同地域AOP群。未指定なら説明文はプレーン表示。
	 * onSelectAop と併せて渡すことで説明文リンクの遷移が有効になる。
	 */
	aops?: readonly Aop[];
	/** 説明文中の地域名をリンク化するための地域群。onSelectRegion と併せて使う */
	regions?: readonly Region[];
	/** 説明文中の地域名をタップしたときの遷移先。未指定なら地域名はリンク化しない */
	onSelectRegion?: (regionId: string) => void;
	/** 「戻る」導線。説明文/所属リンクで遷移した後、元のAOPへ戻る。未指定なら非表示 */
	onBack?: () => void;
	/** 戻り先AOPの表示名。「戻る」ボタンのラベルに使う */
	backToName?: string;
	/**
	 * 参考リンク欄(ユーザ固有・要ログイン)。ログイン制御・データ取得を含むため
	 * パネル外(呼び出し元)で組み立てて差し込む。未指定なら参考リンク欄を表示しない
	 * (embed等の公開ビューでは渡さない)。
	 */
	referenceLinksSlot?: ReactNode;
}) {
	// 前後移動・戻るのいずれかが渡されたときだけナビ行を表示する
	const showNav = onPrev !== undefined || onNext !== undefined;
	const kindLabel =
		aop.kind === "vineyard"
			? getVineyardTermJa(aop.region)
			: KIND_LABELS_JA[aop.kind];
	return (
		<div className={compact ? "space-y-2 p-3" : "space-y-3 p-4"}>
			{onBack && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onBack}
					className="-ml-2 h-auto gap-1 py-1 text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-4" aria-hidden />
					<span className="truncate">
						{backToName ? `${backToName}に戻る` : "戻る"}
					</span>
				</Button>
			)}
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
						className={cn("-mr-1 -mt-1 shrink-0", closeButtonClassName)}
					>
						<XIcon className="size-4" />
					</Button>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				<KindBadge aop={aop} />
				<ClassificationBadge aop={aop} />
				<AppellationBadge aop={aop} />
				{aop.colors.map((c) => (
					<span
						key={c}
						className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
					>
						{COLOR_LABELS_JA[c]}
					</span>
				))}
			</div>

			{onStartQuiz && (quizQuestionCount ?? 0) > 0 && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onStartQuiz}
					className="w-full"
				>
					<GraduationCapIcon className="size-4" aria-hidden />
					このAOPのクイズに挑戦({quizQuestionCount}問)
				</Button>
			)}

			{ancestry && (
				<AncestrySection ancestry={ancestry} onSelectAop={onSelectAop} />
			)}

			{!compact && (
				<p className="text-sm leading-relaxed">
					<AopDescription
						aop={aop}
						aops={aops}
						regions={regions}
						onSelectAop={onSelectAop}
						onSelectRegion={onSelectRegion}
					/>
				</p>
			)}

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

			{referenceLinksSlot}

			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{getBoundarySourceNoteJa(aop)}
			</p>
		</div>
	);
}

// 説明文をリンク付きで描画する。説明文中に現れる同地域の他AOP名・地域名を
// buildDescriptionSegments で検出し、該当箇所を遷移トリガーのリンク風ボタンにする。
// aops 未指定(embed等でリンク候補が無い)時は素のテキストとして表示する。
function AopDescription({
	aop,
	aops,
	regions,
	onSelectAop,
	onSelectRegion,
}: {
	aop: Aop;
	aops?: readonly Aop[];
	regions?: readonly Region[];
	onSelectAop?: (aopId: string) => void;
	onSelectRegion?: (regionId: string) => void;
}) {
	const segments = useMemo(() => {
		if (!aops) return null;
		return buildDescriptionSegments(aop.description, {
			currentAop: aop,
			aops,
			regions: regions ?? [],
		});
	}, [aop, aops, regions]);

	if (!segments) return aop.description;

	return (
		<>
			{segments.map((seg, i) => {
				if (seg.kind === "aop" && onSelectAop) {
					return (
						<DescriptionLink
							// biome-ignore lint/suspicious/noArrayIndexKey: セグメントは順序のみが意味を持ち安定
							key={i}
							text={seg.text}
							onClick={() => onSelectAop(seg.aopId)}
						/>
					);
				}
				if (seg.kind === "region" && onSelectRegion) {
					return (
						<DescriptionLink
							// biome-ignore lint/suspicious/noArrayIndexKey: セグメントは順序のみが意味を持ち安定
							key={i}
							text={seg.text}
							onClick={() => onSelectRegion(seg.regionId)}
						/>
					);
				}
				// リンク先ハンドラが無い区分はテキストとして描く
				// biome-ignore lint/suspicious/noArrayIndexKey: セグメントは順序のみが意味を持ち安定
				return <span key={i}>{seg.text}</span>;
			})}
		</>
	);
}

// 説明文中の他AOP名・地域名を遷移トリガーにするリンク風ボタン(生産者リンクと同じ下線)。
function DescriptionLink({
	text,
	onClick,
}: {
	text: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="underline decoration-dotted underline-offset-2 hover:text-foreground"
		>
			{text}
		</button>
	);
}

// 主要な生産者のリストを表示する。購入リンク(アフィリエイト)を持つ生産者は
// 名前をリンクにし、タップで開くダイアログ内に楽天/Amazonリンク・広告表記をまとめる。
// winery(シャトー)の producers は所有者/運営体なのでリンクせず、代わりにシャトー名
// 自体をリンクにして、シャトーを検索する購入リンクをダイアログで出す。
function ProducersSection({
	aop,
	affiliate,
}: {
	aop: Aop;
	affiliate: AffiliateConfig;
}) {
	// 開いている購入リンクダイアログの対象(生産者名/シャトー名・リンク・解説)。null で非表示
	const [selected, setSelected] = useState<{
		name: string;
		links: PurchaseLinks;
		info: ProducerInfo | null;
	} | null>(null);
	const wineryLinks = getWineryPurchaseLinks(aop, affiliate);
	const rows = aop.producers.map((p) => ({
		producer: p,
		links: wineryLinks ? null : getProducerPurchaseLinks(p, affiliate),
	}));
	return (
		<section>
			<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				主要な生産者
			</h3>
			<ul className="list-inside list-disc text-sm leading-relaxed">
				{rows.map(({ producer, links }) => (
					<li key={producer.name}>
						{links ? (
							<ProducerLinkButton
								name={producer.name}
								onClick={() =>
									setSelected({
										name: producer.name,
										links,
										info: getProducerInfo(producer.name) ?? null,
									})
								}
							/>
						) : (
							producer.name
						)}
					</li>
				))}
			</ul>
			{wineryLinks && (
				<p className="mt-1 text-sm leading-relaxed">
					<ProducerLinkButton
						name={aop.nameJa}
						onClick={() =>
							setSelected({
								name: aop.nameJa,
								links: wineryLinks,
								info: null,
							})
						}
					/>
					のワインを探す
				</p>
			)}
			<ProducerPurchaseDialog
				open={selected !== null}
				onOpenChange={(open) => {
					if (!open) setSelected(null);
				}}
				name={selected?.name ?? ""}
				links={selected?.links ?? null}
				info={selected?.info ?? null}
			/>
		</section>
	);
}

// 生産者名/シャトー名を購入リンクダイアログのトリガーにするリンク風ボタン。
function ProducerLinkButton({
	name,
	onClick,
}: {
	name: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={`${name}の購入リンクを開く`}
			className="underline decoration-dotted underline-offset-2 hover:text-foreground"
		>
			{name}
		</button>
	);
}

// 購入リンクのダイアログ。楽天/Amazonの検索結果へ飛ぶボタン風リンク(広告リンクなので
// rel="sponsored")と、景品表示法(ステマ規制)対応の広告表記(PRバッジ・注記)を含む。
function ProducerPurchaseDialog({
	open,
	onOpenChange,
	name,
	links,
	info,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	name: string;
	links: PurchaseLinks | null;
	info: ProducerInfo | null;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-1.5 pr-6">
						<span className="shrink-0 rounded-sm border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">
							PR
						</span>
						<span className="min-w-0 truncate">{name}</span>
					</DialogTitle>
				</DialogHeader>
				{info?.description && (
					<p className="text-sm leading-relaxed text-foreground/90">
						{info.description}
					</p>
				)}
				{info && (
					<a
						href={MICHELIN_GRAPES_ARTICLE_URL}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`${name}のMICHELIN Grapes掲載記事を開く`}
						className={buttonVariants({ variant: "outline" })}
					>
						MICHELIN Grapes
					</a>
				)}
				{info?.officialWebsite && (
					<a
						href={info.officialWebsite}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`${name}の公式サイトを開く`}
						className={buttonVariants({ variant: "outline" })}
					>
						公式サイト
					</a>
				)}
				{links && (
					<div className="flex flex-col gap-2">
						<a
							href={links.rakuten}
							target="_blank"
							rel="sponsored nofollow noopener"
							aria-label={`${name}のワインを楽天市場で探す`}
							className={buttonVariants({ variant: "outline" })}
						>
							楽天市場で探す
						</a>
						<a
							href={links.amazon}
							target="_blank"
							rel="sponsored nofollow noopener"
							aria-label={`${name}のワインをAmazonで探す`}
							className={buttonVariants({ variant: "outline" })}
						>
							Amazonで探す
						</a>
					</div>
				)}
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					※「楽天」「Amazon」は広告リンク(アフィリエイト)です
				</p>
			</DialogContent>
		</Dialog>
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
	const { regionNameJa, subregionNameJa, villages, parentVineyard } = ancestry;
	const regionPath = [subregionNameJa, regionNameJa]
		.filter(Boolean)
		.join(" ・ ");

	return (
		<section>
			<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				所属
			</h3>
			{parentVineyard && (
				<div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
					<span className="text-muted-foreground">
						{isLegalAppellation(parentVineyard) ? "所属AOC" : "総称"}
					</span>
					{onSelectAop ? (
						<DescriptionLink
							text={parentVineyard.nameJa}
							onClick={() => onSelectAop(parentVineyard.id)}
						/>
					) : (
						<span>{parentVineyard.nameJa}</span>
					)}
				</div>
			)}
			{villages.length > 0 && (
				<div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
					<span className="text-muted-foreground">
						{villages.length > 1 ? "村名AOC(複数村にまたがる)" : "村名AOC"}
					</span>
					{villages.map((v) =>
						onSelectAop ? (
							<DescriptionLink
								key={v.id}
								text={v.nameJa}
								onClick={() => onSelectAop(v.id)}
							/>
						) : (
							<span key={v.id}>{v.nameJa}</span>
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
