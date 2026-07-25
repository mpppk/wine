import { CheckIcon, ChevronsUpDownIcon, StarIcon } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { GrapeVarietyMultiSelect } from "#/components/cellar/GrapeVarietyMultiSelect";
import { Button } from "#/components/ui/button";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";
import { getAop, listAops, listRegions } from "#/lib/wine/service";

const REGION_NONE = "__none__";

export interface DrunkWineFieldsProps {
	value: DrunkWineFieldsValue;
	/** 変更のあったキーだけを渡す。呼び出し側が state にマージする。 */
	onChange: (patch: Partial<DrunkWineFieldsValue>) => void;
	/**
	 * ぶどう品種とメモの間に差し込む写真UI。Web版フォームだけが渡す
	 * (写真の追加・削除は認証必須の /api/wine-photos を叩くため、
	 * 無認証で動く MCP App のフォームからは操作できない)。
	 */
	photoSlot?: React.ReactNode;
}

/**
 * 「飲んだワイン」の入力項目一式。Web版フォーム(DrunkWineForm)と
 * MCP App のフォーム(/embed/drunk-wine)で共有する表示層。
 *
 * 以前は MCP App 側が apps.ts のテンプレート文字列内 vanilla JS で同じフォームを
 * 別実装しており、photo_urls 非対応などのドリフトが起きていた(#155/#189)。
 * 表示の単一情報源をこのコンポーネントに寄せ、保存経路の違い(server fn か
 * ホスト仲介の tools/call か)だけを呼び出し側が持つ。
 *
 * <form> は含めない。MCP App はホストのサンドボックス iframe(allow-forms が
 * 付かないことがある)の中で動くため、保存は submit ではなくボタンの onClick で
 * 行う必要がある。
 */
export function DrunkWineFields({
	value,
	onChange,
	photoSlot,
}: DrunkWineFieldsProps) {
	const [aopPickerOpen, setAopPickerOpen] = useState(false);
	const regions = useMemo(() => listRegions().filter((r) => r.enabled), []);
	const aopCandidates = useMemo(
		() => (value.regionId ? listAops({ regionId: value.regionId }) : []),
		[value.regionId],
	);
	const selectedAop = value.aopId ? getAop(value.aopId) : undefined;

	return (
		<>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="wine-name">
					名前 <span className="text-destructive">*</span>
				</Label>
				<Input
					id="wine-name"
					type="text"
					value={value.name}
					onChange={(e) => onChange({ name: e.target.value })}
					placeholder="例: シャブリ プルミエ・クリュ"
					maxLength={200}
					required
				/>
			</div>

			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-drank-on">飲んだ日</Label>
					<Input
						id="wine-drank-on"
						type="date"
						value={value.drankOn}
						onChange={(e) => onChange({ drankOn: e.target.value })}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label>評価</Label>
					<div className="flex h-9 items-center gap-0.5">
						{[1, 2, 3, 4, 5].map((n) => {
							const active = value.rating !== null && n <= value.rating;
							return (
								<button
									key={n}
									type="button"
									aria-label={`星${n}`}
									aria-pressed={value.rating === n}
									onClick={() =>
										onChange({ rating: value.rating === n ? null : n })
									}
									className="rounded-sm p-1 transition-transform hover:scale-110 focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
								>
									<StarIcon
										className={cn(
											"size-6",
											active
												? "fill-amber-400 text-amber-400"
												: "text-muted-foreground/40",
										)}
										aria-hidden
									/>
								</button>
							);
						})}
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-vintage">ヴィンテージ</Label>
					<Input
						id="wine-vintage"
						type="number"
						min={1800}
						max={2100}
						value={value.vintage}
						onChange={(e) => onChange({ vintage: e.target.value })}
						placeholder="例: 2020"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-producer">生産者</Label>
					<Input
						id="wine-producer"
						type="text"
						value={value.producer}
						onChange={(e) => onChange({ producer: e.target.value })}
						placeholder="例: ドメーヌ・ルフレーヴ"
						maxLength={200}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="wine-price">価格(円)</Label>
					<Input
						id="wine-price"
						type="number"
						min={0}
						max={10_000_000}
						value={value.price}
						onChange={(e) => onChange({ price: e.target.value })}
						placeholder="例: 5000"
					/>
				</div>
			</div>

			<fieldset className="flex flex-col gap-3">
				<Label asChild>
					<legend>AOP紐付け(任意)</legend>
				</Label>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<Select
						value={value.regionId ?? REGION_NONE}
						onValueChange={(v) => {
							const next = v === REGION_NONE ? undefined : v;
							// 地域を変えたら別地域のAOPが残らないようクリアする
							const keepAop =
								value.aopId && getAop(value.aopId)?.region === next;
							onChange({
								regionId: next,
								...(keepAop ? {} : { aopId: undefined }),
							});
						}}
					>
						<SelectTrigger aria-label="地域を選択">
							<SelectValue placeholder="地域を選択" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={REGION_NONE}>紐付けない</SelectItem>
							{regions.map((r) => (
								<SelectItem key={r.id} value={r.id}>
									{r.nameJa}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					{value.regionId && (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => setAopPickerOpen(true)}
								className="justify-between font-normal"
							>
								<span className={cn(!selectedAop && "text-muted-foreground")}>
									{selectedAop ? selectedAop.nameJa : "AOPを選択"}
								</span>
								<ChevronsUpDownIcon className="size-4 opacity-50" aria-hidden />
							</Button>
							<CommandDialog
								open={aopPickerOpen}
								onOpenChange={setAopPickerOpen}
								title="AOPを選択"
								description="AOPを検索して選択します。"
							>
								<CommandInput placeholder="AOPを検索(日本語・現地語)…" />
								<CommandList>
									<CommandEmpty>該当するAOPがありません。</CommandEmpty>
									<CommandGroup>
										<CommandItem
											value={REGION_NONE}
											keywords={["紐付けない", "クリア", "none"]}
											onSelect={() => {
												onChange({ aopId: undefined });
												setAopPickerOpen(false);
											}}
										>
											<CheckIcon
												className={cn(
													"size-4",
													value.aopId === undefined
														? "opacity-100"
														: "opacity-0",
												)}
												aria-hidden
											/>
											紐付けない
										</CommandItem>
										{aopCandidates.map((aop) => (
											<CommandItem
												key={aop.id}
												value={aop.id}
												keywords={[aop.nameJa, aop.shortName]}
												onSelect={() => {
													onChange({ aopId: aop.id });
													setAopPickerOpen(false);
												}}
											>
												<CheckIcon
													className={cn(
														"size-4",
														aop.id === value.aopId
															? "opacity-100"
															: "opacity-0",
													)}
													aria-hidden
												/>
												<span>{aop.nameJa}</span>
												<span className="text-xs text-muted-foreground">
													{aop.shortName}
												</span>
											</CommandItem>
										))}
									</CommandGroup>
								</CommandList>
							</CommandDialog>
						</>
					)}
				</div>
			</fieldset>

			<fieldset className="flex flex-col gap-3">
				<Label asChild>
					<legend>ぶどう品種(複数選択可)</legend>
				</Label>
				<GrapeVarietyMultiSelect
					value={value.grapeVarietyIds}
					onChange={(ids) => onChange({ grapeVarietyIds: ids })}
				/>
			</fieldset>

			{photoSlot}

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="wine-memo">メモ</Label>
				<Textarea
					id="wine-memo"
					value={value.memo}
					onChange={(e) => onChange({ memo: e.target.value })}
					placeholder="味わいの感想、合わせた料理など"
					maxLength={2000}
					rows={4}
				/>
			</div>
		</>
	);
}
