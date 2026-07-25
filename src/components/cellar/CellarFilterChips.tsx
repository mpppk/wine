import { CELLAR_FILTERS, type CellarFilterId } from "#/lib/drunk-wine/filter";

// マイセラーの絞り込みチップ。一覧(/cellar)と地図(/cellar/map)の両方に置き、
// URL の ?filter= で連動させる。見た目は地図の地域切替チップ(cellar.map.tsx)と
// 同じイディオム(丸チップ + aria-pressed + 件数バッジ)を踏襲する。
//
// 排他タブではなく独立した絞り込み条件で、1本のワインが「飲んだことがある」と
// 「セラーにある」の両方に該当しうる(＝以前飲んで買い直したケース)。

export function CellarFilterChips({
	value,
	counts,
	onChange,
}: {
	value: CellarFilterId;
	counts: Record<CellarFilterId, number>;
	onChange: (next: CellarFilterId) => void;
}) {
	return (
		<fieldset
			className="flex flex-wrap items-center gap-1"
			aria-label="マイセラーの絞り込み"
		>
			{CELLAR_FILTERS.map((f) => {
				const active = f.id === value;
				const count = counts[f.id];
				return (
					<button
						key={f.id}
						type="button"
						disabled={count === 0 && !active}
						aria-pressed={active}
						onClick={() => onChange(f.id)}
						className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
							active
								? "border-transparent bg-foreground text-background"
								: "border-border text-muted-foreground hover:border-foreground/40"
						}`}
					>
						{f.labelJa}
						<span
							className={`inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium ${
								active ? "bg-background/20" : "bg-muted text-muted-foreground"
							}`}
						>
							{count}
						</span>
					</button>
				);
			})}
		</fieldset>
	);
}
