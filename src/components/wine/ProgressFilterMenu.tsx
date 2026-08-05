import { Link } from "@tanstack/react-router";
import {
	ChevronDownIcon,
	FunnelIcon,
	LogInIcon,
	SproutIcon,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	PROGRESS_FILTER_STATES,
	progressLabelJa,
	progressToken,
} from "#/lib/wine/aop-filter";
import { PROGRESS_ACCENT_COLOR } from "#/lib/wine/map-style";

// 学習の進捗による絞り込みチップ。区分・格付けのマルチセレクト(KindFacetMenu)と
// 同じ見た目・同じトグル規則(0個選択=非選択 / 全選択=選択 / 一部のみ=選択+漏斗)に
// 揃える。区分色ではなく進捗ヒートマップの緑で塗り、同じ「進捗」を指していることを
// 見た目でも結びつける。
//
// 未ログイン時は正解が記録されず全AOPが「未着手」に潰れるため、絞り込みは効かせず
// (呼び出し側が進捗トークンを無効化する)、メニューをログイン導線に差し替える。
// チップ自体は出す — 進捗で絞れること自体がログインの動機になる。
export function ProgressFilterMenu({
	hideSet,
	onToggle,
	isAuthenticated,
}: {
	/** 非表示トークンの集合(区分・格付けと共通の `hide` パラメータ由来) */
	hideSet: ReadonlySet<string>;
	onToggle: (token: string) => void;
	isAuthenticated: boolean;
}) {
	const tokens = PROGRESS_FILTER_STATES.map(progressToken);
	const selectedCount = tokens.filter((t) => !hideSet.has(t)).length;
	// 未ログインは絞り込みが効かないので、常に「絞り込んでいない」見た目に固定する
	const anySelected = !isAuthenticated || selectedCount > 0;
	const partial =
		isAuthenticated && selectedCount > 0 && selectedCount < tokens.length;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-pressed={anySelected}
					aria-label="学習の進捗で絞り込み"
					className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
						anySelected
							? "border-transparent text-white"
							: "border-border text-muted-foreground hover:border-foreground/40"
					}`}
					style={
						anySelected
							? { backgroundColor: PROGRESS_ACCENT_COLOR.fill }
							: undefined
					}
				>
					<SproutIcon className="size-3" aria-hidden />
					進捗
					{partial && (
						<FunnelIcon
							className="size-3 fill-current"
							aria-label="一部の進捗で絞り込み中"
						/>
					)}
					<ChevronDownIcon className="size-3" aria-hidden />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{isAuthenticated ? (
					PROGRESS_FILTER_STATES.map((state) => {
						const token = progressToken(state);
						return (
							<DropdownMenuItem
								key={token}
								// トグルしてもメニューを閉じない(複数選択を続けやすく)
								onSelect={(e) => {
									e.preventDefault();
									onToggle(token);
								}}
								className="gap-2"
							>
								<Checkbox
									checked={!hideSet.has(token)}
									className="pointer-events-none"
								/>
								{progressLabelJa(state)}
							</DropdownMenuItem>
						);
					})
				) : (
					<div className="flex max-w-56 flex-col gap-2 p-2">
						<p className="text-xs text-muted-foreground">
							ログインすると学習の進捗で地図・リストを絞り込めます
						</p>
						<Button asChild size="sm" variant="secondary">
							<Link to="/login">
								<LogInIcon className="size-3.5" aria-hidden />
								ログイン
							</Link>
						</Button>
					</div>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
