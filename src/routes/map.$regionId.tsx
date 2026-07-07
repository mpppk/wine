import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { AopDetailPanel } from "#/components/wine/AopDetailPanel";
import { AopMapView } from "#/components/wine/AopMapView";
import { GrapeFilterSelect } from "#/components/wine/GrapeFilterSelect";
import {
	CLASSIFICATION_COLORS,
	CLASSIFICATION_LABELS_JA,
	CLASSIFICATIONS,
} from "#/lib/wine/map-style";
import { aopAllowsGrape, getRegion, listAops } from "#/lib/wine/service";
import type { Aop, Classification } from "#/lib/wine/types";
import { getSession } from "#/server/auth";

const searchSchema = z.object({
	/** ブドウ品種フィルタ(variety id) */
	grape: z.string().optional(),
	/** 選択中のAOP(slug) */
	aop: z.string().optional(),
	/** 表示する格付け(カンマ区切り)。省略時は全格付け */
	cls: z.string().optional(),
});

export const Route = createFileRoute("/map/$regionId")({
	validateSearch: searchSchema,
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: ({ params }) => {
		const region = getRegion(params.regionId);
		if (!region?.enabled) {
			throw redirect({ to: "/regions" });
		}
		return { region, aops: listAops({ regionId: region.id }) };
	},
	component: MapPage,
});

function parseClassifications(cls: string | undefined): Classification[] {
	if (!cls) return CLASSIFICATIONS;
	const parts = cls.split(",");
	const valid = CLASSIFICATIONS.filter((c) => parts.includes(c));
	return valid.length > 0 ? valid : CLASSIFICATIONS;
}

function MapPage() {
	const { region, aops } = Route.useLoaderData();
	const { grape, aop: selectedAopId, cls } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });

	const visibleClassifications = useMemo(
		() => parseClassifications(cls),
		[cls],
	);
	const selectedAop = aops.find((a) => a.id === selectedAopId);

	// サイドバー一覧: 地図と同じフィルタを反映する
	const listedAops = useMemo(
		() =>
			aops.filter(
				(a) =>
					visibleClassifications.includes(a.classification) &&
					(!grape || aopAllowsGrape(a, grape)),
			),
		[aops, visibleClassifications, grape],
	);

	const setSearch = (patch: {
		grape?: string | undefined;
		aop?: string | undefined;
		cls?: string | undefined;
	}) => {
		void navigate({
			search: (prev) => ({ ...prev, ...patch }),
			replace: true,
		});
	};

	const toggleClassification = (c: Classification) => {
		const next = visibleClassifications.includes(c)
			? visibleClassifications.filter((x) => x !== c)
			: [...visibleClassifications, c];
		// 全部OFFは意味がないので、その場合は全表示へ戻す
		setSearch({
			cls:
				next.length === 0 || next.length === CLASSIFICATIONS.length
					? undefined
					: next.join(","),
		});
	};

	return (
		<main className="flex h-[calc(100dvh-57px)] flex-col sm:h-[calc(100dvh-65px)]">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
				<div className="flex items-center gap-2">
					<Button
						asChild
						variant="ghost"
						size="icon"
						aria-label="地域選択へ戻る"
					>
						<Link to="/regions">
							<ArrowLeftIcon className="size-4" />
						</Link>
					</Button>
					<h1 className="text-base font-semibold">
						{region.nameJa}
						<span className="ml-2 hidden text-sm font-normal text-muted-foreground sm:inline">
							{region.nameLocal} ・ {listedAops.length} AOP
						</span>
					</h1>
				</div>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					<fieldset
						className="flex items-center gap-1"
						aria-label="格付けフィルタ"
					>
						{CLASSIFICATIONS.map((c) => {
							const active = visibleClassifications.includes(c);
							return (
								<button
									key={c}
									type="button"
									onClick={() => toggleClassification(c)}
									aria-pressed={active}
									className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
										active
											? "border-transparent text-white"
											: "border-border text-muted-foreground hover:border-foreground/40"
									}`}
									style={
										active
											? { backgroundColor: CLASSIFICATION_COLORS[c].fill }
											: undefined
									}
								>
									{CLASSIFICATION_LABELS_JA[c]}
								</button>
							);
						})}
					</fieldset>

					<GrapeFilterSelect
						value={grape}
						onChange={(v) => setSearch({ grape: v })}
					/>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1">
				<AopMapView
					region={region}
					aops={aops}
					selectedAopId={selectedAopId}
					grapeVarietyId={grape}
					visibleClassifications={visibleClassifications}
					onSelectAop={(id) => setSearch({ aop: id })}
					className="min-w-0 flex-1"
				/>

				{/* デスクトップ: 右サイドバー(一覧 or 詳細) */}
				<aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border lg:block">
					{selectedAop ? (
						<AopDetailPanel
							aop={selectedAop}
							onClose={() => setSearch({ aop: undefined })}
						/>
					) : (
						<AopList
							aops={listedAops}
							subregions={region.subregions}
							onSelect={(id) => setSearch({ aop: id })}
						/>
					)}
				</aside>

				{/* モバイル: 詳細を下部オーバーレイで表示 */}
				{selectedAop && (
					<div className="absolute inset-x-2 bottom-2 max-h-[55%] overflow-y-auto rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur lg:hidden">
						<AopDetailPanel
							aop={selectedAop}
							onClose={() => setSearch({ aop: undefined })}
						/>
					</div>
				)}
			</div>
		</main>
	);
}

function AopList({
	aops,
	subregions,
	onSelect,
}: {
	aops: Aop[];
	subregions: { id: string; nameJa: string }[];
	onSelect: (aopId: string) => void;
}) {
	if (aops.length === 0) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				条件に一致するAOPがありません。フィルタを変更してください。
			</p>
		);
	}
	return (
		<nav aria-label="AOP一覧" className="p-2">
			{subregions.map((sub) => {
				const group = aops.filter((a) => a.subregionId === sub.id);
				if (group.length === 0) return null;
				return (
					<section key={sub.id} className="mb-3">
						<h3 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							{sub.nameJa}
						</h3>
						<ul>
							{group.map((aop) => (
								<li key={aop.id}>
									<button
										type="button"
										onClick={() => onSelect(aop.id)}
										className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
									>
										<span
											aria-hidden
											className="size-2.5 shrink-0 rounded-full"
											style={{
												backgroundColor:
													CLASSIFICATION_COLORS[aop.classification].fill,
											}}
										/>
										<span className="min-w-0 flex-1 truncate">
											{aop.nameJa}
										</span>
										{aop.premierCru && (
											<span className="shrink-0 text-[10px] text-muted-foreground">
												1er
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					</section>
				);
			})}
		</nav>
	);
}
