import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { GRAPE_VARIETIES } from "#/lib/wine/varieties";

const ALL = "__all__";

// ブドウ品種フィルタ。選択すると該当品種が許可されているAOPだけが
// 地図上でハイライトされる(他は灰色に沈む)。
export function GrapeFilterSelect({
	value,
	onChange,
}: {
	value: string | undefined;
	onChange: (varietyId: string | undefined) => void;
}) {
	const reds = GRAPE_VARIETIES.filter((v) => v.color === "red");
	const whites = GRAPE_VARIETIES.filter((v) => v.color === "white");
	return (
		<Select
			value={value ?? ALL}
			onValueChange={(v) => onChange(v === ALL ? undefined : v)}
		>
			<SelectTrigger className="w-56" aria-label="ブドウ品種で絞り込み">
				<SelectValue placeholder="品種で絞り込み" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>すべての品種</SelectItem>
				<SelectGroup>
					<SelectLabel>黒ブドウ</SelectLabel>
					{reds.map((v) => (
						<SelectItem key={v.id} value={v.id}>
							{v.nameJa}
						</SelectItem>
					))}
				</SelectGroup>
				<SelectGroup>
					<SelectLabel>白ブドウ</SelectLabel>
					{whites.map((v) => (
						<SelectItem key={v.id} value={v.id}>
							{v.nameJa}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}
