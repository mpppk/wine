import {
	ArrowLeftIcon,
	CheckIcon,
	ChevronRightIcon,
	ChevronsUpDownIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { cn } from "#/lib/utils";
import { countryForRegion } from "#/lib/wine/countries";
import {
	type AopBrowseItem,
	listAopBrowseItems,
	listCountryOptions,
	listRegionOptions,
	type ProvenanceOption,
	type ProvenanceValue,
	resolveProvenanceOption,
	searchProvenance,
} from "#/lib/wine/provenance";
import { getAop, getRegion } from "#/lib/wine/service";

// マイセラーの産地ピッカー。国・地域・AOP(村・畑・クリマ含む)を1つのダイアログで
// 選ぶ: 検索欄が空なら 国 → 地域 → 地区 → AOP のドリルダウン、入力があれば全階層を
// 横断するインクリメンタル検索(候補の列挙・検索は lib/wine/provenance が単一情報源)。
// cmdk の組み込みフィルタは使わない(アクセント除去等の正規化を検索側と揃えるため
// shouldFilter を切り、表示する候補は自前で決める)。

export interface ProvenancePickerProps {
	value: ProvenanceValue;
	/** 選択・解除で3キーすべてを明示的に上書きする(最も細かい1つだけが残る) */
	onChange: (patch: {
		aopId: string | undefined;
		regionId: string | undefined;
		countryId: string | undefined;
	}) => void;
}

/** ドリルダウンの現在位置。undefined のキーから下は未進入。 */
interface BrowsePath {
	countryId?: string;
	regionId?: string;
	subregionId?: string;
}

/** 現在の選択から、開いたときの初期位置を導く(選択済みの階層まで降りておく)。 */
function pathForValue(value: ProvenanceValue): BrowsePath {
	if (value.aopId) {
		const aop = getAop(value.aopId);
		const region = aop ? getRegion(aop.region) : undefined;
		if (aop && region) {
			return {
				countryId: countryForRegion(region)?.id,
				regionId: region.id,
				subregionId: aop.subregionId,
			};
		}
	}
	if (value.regionId) {
		const region = getRegion(value.regionId);
		return { countryId: region ? countryForRegion(region)?.id : undefined };
	}
	if (value.countryId) return { countryId: value.countryId };
	return {};
}

const KIND_SUFFIX = { country: "国", region: "地方", aop: "" } as const;

function OptionRow({
	option,
	selected,
	showBreadcrumb = false,
	onSelect,
	className,
}: {
	option: ProvenanceOption;
	selected: boolean;
	showBreadcrumb?: boolean;
	onSelect: (option: ProvenanceOption) => void;
	className?: string;
}) {
	const suffix = KIND_SUFFIX[option.kind];
	return (
		<CommandItem
			value={`${option.kind}:${option.id}`}
			onSelect={() => onSelect(option)}
			className={className}
		>
			<CheckIcon
				className={cn("size-4", selected ? "opacity-100" : "opacity-0")}
				aria-hidden
			/>
			<span className="flex min-w-0 flex-col">
				<span className="truncate">
					{option.nameJa}
					{suffix && (
						<span className="ml-1 text-xs text-muted-foreground">
							({suffix})
						</span>
					)}
				</span>
				{showBreadcrumb && option.breadcrumb.length > 0 && (
					<span className="truncate text-xs text-muted-foreground">
						{option.breadcrumb.join(" > ")}
					</span>
				)}
			</span>
			{!showBreadcrumb && (
				<span className="ml-auto text-xs text-muted-foreground">
					{option.nameLocal}
				</span>
			)}
		</CommandItem>
	);
}

export function ProvenancePicker({ value, onChange }: ProvenancePickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [path, setPath] = useState<BrowsePath>({});

	const selectedOption = useMemo(() => resolveProvenanceOption(value), [value]);
	const isSelected = (option: ProvenanceOption): boolean =>
		selectedOption?.kind === option.kind && selectedOption.id === option.id;

	const openPicker = () => {
		setQuery("");
		setPath(pathForValue(value));
		setOpen(true);
	};

	const select = (option: ProvenanceOption) => {
		onChange({
			aopId: option.value.aopId,
			regionId: option.value.regionId,
			countryId: option.value.countryId,
		});
		setOpen(false);
	};

	const clear = () => {
		onChange({ aopId: undefined, regionId: undefined, countryId: undefined });
		setOpen(false);
	};

	const goBack = () => {
		setPath((p) => {
			if (p.subregionId) return { ...p, subregionId: undefined };
			if (p.regionId) return { countryId: p.countryId };
			return {};
		});
	};

	const region = path.regionId ? getRegion(path.regionId) : undefined;
	const results = query ? searchProvenance(query) : [];

	// 各階層の先頭に出す「この単位に紐付ける」行(降りた先の国・地域を自身で選べる)
	const countryLevelOption =
		path.countryId && !path.regionId
			? resolveProvenanceOption({ countryId: path.countryId })
			: undefined;
	const regionLevelOption =
		path.regionId && !path.subregionId
			? resolveProvenanceOption({ regionId: path.regionId })
			: undefined;

	// ドリルダウンの現在階層のタイトル(戻る行のラベルにも使う)
	const levelTitle = path.subregionId
		? region?.subregions.find((s) => s.id === path.subregionId)?.nameJa
		: path.regionId
			? region?.nameJa
			: path.countryId
				? listCountryOptions().find((c) => c.id === path.countryId)?.nameJa
				: undefined;

	return (
		<>
			<Button
				type="button"
				variant="outline"
				onClick={openPicker}
				className="justify-between font-normal"
			>
				<span className={cn(!selectedOption && "text-muted-foreground")}>
					{selectedOption ? (
						<>
							{selectedOption.nameJa}
							{KIND_SUFFIX[selectedOption.kind] && (
								<span className="ml-1 text-xs text-muted-foreground">
									({KIND_SUFFIX[selectedOption.kind]})
								</span>
							)}
						</>
					) : (
						"産地を選択"
					)}
				</span>
				<ChevronsUpDownIcon className="size-4 opacity-50" aria-hidden />
			</Button>
			<CommandDialog
				open={open}
				onOpenChange={setOpen}
				title="産地を選択"
				description="国・地域・AOPを検索するか、階層をたどって選択します。"
				commandProps={{ shouldFilter: false }}
			>
				<CommandInput
					placeholder="産地を検索(日本語・現地語)…"
					value={query}
					onValueChange={setQuery}
				/>
				<CommandList>
					{query ? (
						<>
							<CommandEmpty>該当する産地がありません。</CommandEmpty>
							<CommandGroup>
								{results.map((option) => (
									<OptionRow
										key={`${option.kind}:${option.id}`}
										option={option}
										selected={isSelected(option)}
										showBreadcrumb
										onSelect={select}
									/>
								))}
							</CommandGroup>
						</>
					) : (
						<CommandGroup>
							{levelTitle && (
								<CommandItem value="__back__" onSelect={goBack}>
									<ArrowLeftIcon className="size-4" aria-hidden />
									戻る
									<span className="ml-auto text-xs text-muted-foreground">
										{levelTitle}
									</span>
								</CommandItem>
							)}

							{!path.countryId && (
								<>
									<CommandItem
										value="__none__"
										keywords={["紐付けない", "クリア", "none"]}
										onSelect={clear}
									>
										<CheckIcon
											className={cn(
												"size-4",
												selectedOption ? "opacity-0" : "opacity-100",
											)}
											aria-hidden
										/>
										紐付けない
									</CommandItem>
									{listCountryOptions().map((option) => (
										<DrillRow
											key={option.id}
											label={option.nameJa}
											sub={option.nameLocal}
											value={`drill-country:${option.id}`}
											onSelect={() => setPath({ countryId: option.id })}
										/>
									))}
								</>
							)}

							{path.countryId && !path.regionId && (
								<>
									{countryLevelOption && (
										<OptionRow
											option={countryLevelOption}
											selected={isSelected(countryLevelOption)}
											onSelect={select}
											className="font-medium"
										/>
									)}
									{listRegionOptions(path.countryId).map((option) => (
										<DrillRow
											key={option.id}
											label={option.nameJa}
											sub={option.nameLocal}
											value={`drill-region:${option.id}`}
											onSelect={() =>
												setPath((p) => ({ ...p, regionId: option.id }))
											}
										/>
									))}
								</>
							)}

							{path.regionId && !path.subregionId && region && (
								<>
									{regionLevelOption && (
										<OptionRow
											option={regionLevelOption}
											selected={isSelected(regionLevelOption)}
											onSelect={select}
											className="font-medium"
										/>
									)}
									{region.subregions.map((subregion) => (
										<DrillRow
											key={subregion.id}
											label={subregion.nameJa}
											value={`drill-subregion:${subregion.id}`}
											onSelect={() =>
												setPath((p) => ({ ...p, subregionId: subregion.id }))
											}
										/>
									))}
								</>
							)}

							{path.regionId && path.subregionId && (
								<AopLevel
									regionId={path.regionId}
									subregionId={path.subregionId}
									isSelected={isSelected}
									onSelect={select}
								/>
							)}
						</CommandGroup>
					)}
				</CommandList>
			</CommandDialog>
		</>
	);
}

/** ドリルダウン専用の行(選択ではなく1階層降りる)。 */
function DrillRow({
	label,
	sub,
	value,
	onSelect,
}: {
	label: string;
	sub?: string;
	value: string;
	onSelect: () => void;
}) {
	return (
		<CommandItem value={value} onSelect={onSelect}>
			{/* チェック列と揃えるためのスペーサ */}
			<span className="size-4" aria-hidden />
			<span className="truncate">{label}</span>
			{sub && (
				<span className="ml-auto text-xs text-muted-foreground">{sub}</span>
			)}
			<ChevronRightIcon
				className={cn("size-4 opacity-50", !sub && "ml-auto")}
				aria-hidden
			/>
		</CommandItem>
	);
}

/** 地区内のAOP一覧。ツリー順(村 > 畑 > クリマ / シャトー)をインデントで表す。 */
function AopLevel({
	regionId,
	subregionId,
	isSelected,
	onSelect,
}: {
	regionId: string;
	subregionId: string;
	isSelected: (option: ProvenanceOption) => boolean;
	onSelect: (option: ProvenanceOption) => void;
}) {
	const items: AopBrowseItem[] = useMemo(
		() => listAopBrowseItems(regionId, subregionId),
		[regionId, subregionId],
	);
	return (
		<>
			{items.map(({ option, depth }) => (
				<OptionRow
					key={option.id}
					option={option}
					selected={isSelected(option)}
					onSelect={onSelect}
					className={cn(depth === 1 && "pl-6", depth === 2 && "pl-10")}
				/>
			))}
		</>
	);
}
