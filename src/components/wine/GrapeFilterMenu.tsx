import { CheckIcon, ChevronDownIcon, GrapeIcon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { GRAPE_VARIETIES, getVariety } from "#/lib/wine/varieties";

// ブドウ品種フィルタ。区分・格付けフィルタのチップ(KindFacetMenu)と同じ見た目に
// 揃え、普段は控えめなチップとして畳んでおく。選択するとその品種が許可されている
// AOPだけが地図上でハイライトされる(他は灰色に沈む)/リストでは絞り込まれる。
// 品種は単一選択。選択中はチップに品種名を出し、選択済み状態として強調する。
export function GrapeFilterMenu({
	value,
	onChange,
}: {
	value: string | undefined;
	onChange: (varietyId: string | undefined) => void;
}) {
	const selected = value ? getVariety(value) : undefined;
	const active = !!selected;
	const reds = GRAPE_VARIETIES.filter((v) => v.color === "red");
	const whites = GRAPE_VARIETIES.filter((v) => v.color === "white");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-pressed={active}
					aria-label="ブドウ品種で絞り込み"
					className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
						active
							? "border-transparent bg-foreground text-background"
							: "border-border text-muted-foreground hover:border-foreground/40"
					}`}
				>
					<GrapeIcon className="size-3" aria-hidden />
					{selected ? selected.nameJa : "品種"}
					<ChevronDownIcon className="size-3" aria-hidden />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
				<DropdownMenuItem
					className="gap-2"
					onSelect={() => onChange(undefined)}
				>
					<CheckIcon
						className={`size-4 ${active ? "invisible" : ""}`}
						aria-hidden
					/>
					すべての品種
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>黒ブドウ</DropdownMenuLabel>
				{reds.map((v) => (
					<GrapeItem
						key={v.id}
						nameJa={v.nameJa}
						checked={v.id === value}
						onSelect={() => onChange(v.id)}
					/>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuLabel>白ブドウ</DropdownMenuLabel>
				{whites.map((v) => (
					<GrapeItem
						key={v.id}
						nameJa={v.nameJa}
						checked={v.id === value}
						onSelect={() => onChange(v.id)}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function GrapeItem({
	nameJa,
	checked,
	onSelect,
}: {
	nameJa: string;
	checked: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem className="gap-2" onSelect={onSelect}>
			<CheckIcon
				className={`size-4 ${checked ? "" : "invisible"}`}
				aria-hidden
			/>
			{nameJa}
		</DropdownMenuItem>
	);
}
