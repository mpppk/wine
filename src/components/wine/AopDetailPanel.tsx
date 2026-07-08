import { XIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import type { AopAncestry } from "#/lib/wine/aop-tree";
import {
	CLASSIFICATION_COLORS,
	CLASSIFICATION_LABELS_JA,
} from "#/lib/wine/map-style";
import type { Aop, WineColor } from "#/lib/wine/types";
import { getVariety } from "#/lib/wine/varieties";

const COLOR_LABELS_JA: Record<WineColor, string> = {
	red: "赤",
	white: "白",
	rose: "ロゼ",
	sparkling: "泡",
};

export function ClassificationBadge({ aop }: { aop: Aop }) {
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium"
			style={{ borderColor: CLASSIFICATION_COLORS[aop.classification].line }}
		>
			<span
				aria-hidden
				className="size-2 rounded-full"
				style={{
					backgroundColor: CLASSIFICATION_COLORS[aop.classification].fill,
				}}
			/>
			{CLASSIFICATION_LABELS_JA[aop.classification]}
			{aop.premierCru && " / 1er Cruあり"}
		</span>
	);
}

export function AopDetailPanel({
	aop,
	ancestry,
	onSelectAop,
	onClose,
	compact = false,
}: {
	aop: Aop;
	/** 所属する親(村名AOC・地区・地方)の情報。未指定なら所属セクションを表示しない */
	ancestry?: AopAncestry;
	/** 親の村名AOCをタップしたときの遷移先。未指定なら親はテキスト表示のみ */
	onSelectAop?: (aopId: string) => void;
	onClose?: () => void;
	/** embed用: 余白と文字量を切り詰める */
	compact?: boolean;
}) {
	return (
		<div className={compact ? "space-y-2 p-3" : "space-y-3 p-4"}>
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
				<ClassificationBadge aop={aop} />
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

			<section>
				<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					主要な生産者
				</h3>
				<ul className="list-inside list-disc text-sm leading-relaxed">
					{aop.producers.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ul>
			</section>

			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{aop.classification === "regional"
					? "地図はコミューン(市町村)単位の生産地域を表示しています。"
					: "地図はINAOの区画データを簡略化して表示しています。"}
			</p>
		</div>
	);
}

// 所属する親(村名AOC・地区・地方)を表示する。グラン・クリュの畑は複数村に
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
