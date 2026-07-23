import type { ReactNode } from "react";

/** 基本情報カードの定義リスト(dt/dd)1行。 */
export function InfoRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 py-1.5 text-sm">
			<dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all">{children}</dd>
		</div>
	);
}
