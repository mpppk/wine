import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { useState } from "react";
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
import { GRAPE_VARIETIES, getVariety } from "#/lib/wine/varieties";

// ぶどう品種の複数選択。品種は今後も増えるため、全品種を並べたチェックボックスの
// 代わりに検索付きの multi-select にする。トリガーを押すと CommandDialog(AOP選択と
// 同じ検索UI)が開き、日本語・現地語で絞り込みながら複数トグルできる。選択済みは
// 下にチップで並べ、その場で外せる。ダイアログは選択のたびに閉じない(連続選択のため)。
export function GrapeVarietyMultiSelect({
	value,
	onChange,
}: {
	value: string[];
	onChange: (ids: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const reds = GRAPE_VARIETIES.filter((v) => v.color === "red");
	const whites = GRAPE_VARIETIES.filter((v) => v.color === "white");
	// 未知IDは無視しつつ、選択順(=value順)を保ってチップ表示する
	const selected = value
		.map((id) => getVariety(id))
		.filter((v): v is NonNullable<typeof v> => v != null);

	const toggle = (id: string) => {
		onChange(
			value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
		);
	};

	return (
		<div className="flex flex-col gap-2">
			<Button
				type="button"
				variant="outline"
				onClick={() => setOpen(true)}
				className="w-full justify-between font-normal sm:max-w-xs"
			>
				<span className={cn(selected.length === 0 && "text-muted-foreground")}>
					{selected.length > 0
						? `${selected.length}品種を選択中`
						: "ぶどう品種を選択"}
				</span>
				<ChevronsUpDownIcon className="size-4 opacity-50" aria-hidden />
			</Button>

			{selected.length > 0 && (
				<ul className="flex flex-wrap gap-1.5">
					{selected.map((v) => (
						<li key={v.id}>
							<span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted py-1 pl-2.5 pr-1 text-xs">
								{v.nameJa}
								<button
									type="button"
									aria-label={`${v.nameJa}を選択解除`}
									onClick={() => toggle(v.id)}
									className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
								>
									<XIcon className="size-3" aria-hidden />
								</button>
							</span>
						</li>
					))}
				</ul>
			)}

			<CommandDialog
				open={open}
				onOpenChange={setOpen}
				title="ぶどう品種を選択"
				description="ぶどう品種を検索して複数選択します。"
			>
				<CommandInput placeholder="品種を検索(日本語・現地語)…" />
				<CommandList>
					<CommandEmpty>該当する品種がありません。</CommandEmpty>
					{[
						{ label: "黒ブドウ", varieties: reds },
						{ label: "白ブドウ", varieties: whites },
					].map((group) => (
						<CommandGroup key={group.label} heading={group.label}>
							{group.varieties.map((v) => (
								<CommandItem
									key={v.id}
									value={v.id}
									keywords={[v.nameJa, v.nameLocal]}
									onSelect={() => toggle(v.id)}
								>
									<CheckIcon
										className={cn(
											"size-4",
											value.includes(v.id) ? "opacity-100" : "opacity-0",
										)}
										aria-hidden
									/>
									<span>{v.nameJa}</span>
									<span className="text-xs text-muted-foreground">
										{v.nameLocal}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					))}
				</CommandList>
			</CommandDialog>
		</div>
	);
}
