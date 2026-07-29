import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LogInIcon, PlusIcon, WineIcon } from "lucide-react";
import { useState } from "react";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { listDrunkWinesByAop } from "#/server/drunk-wine";

// 情報パネル(AopDetailPanel)内の「マイセラー」セクション。表示中のAOPを紐付けた
// 自分の登録ワインを並べ、各行から編集画面へ遷移できるようにする。地図で産地を眺め
// ながら「ここのワインは飲んだことがある」を思い出せるようにするのが目的。
//
// 参考リンク欄(AopReferenceLinks)と同じ構え: データ取得はこのコンポーネントに
// 閉じ込め、パネル本体は表示専用のまま保つ。非ログイン時はログイン導線のみ表示し、
// embed(公開iframe)からはこのスロット自体を渡さない。

const SECTION_HEADING = "マイセラー";

/**
 * 折りたたまずに常時表示する件数。これを超える分は「ほかN件を表示」で開く。
 * 情報パネルは産地の情報が主役なので、同一AOPに大量登録がある人でもセクションが
 * パネルを占有しないようにする(生産者リストと同じ扱い)。
 */
const COLLAPSE_THRESHOLD = 5;

function cellarWinesKey(aopId: string) {
	return ["cellarWinesByAop", aopId] as const;
}

function SectionShell({ children }: { children: React.ReactNode }) {
	return (
		<section>
			<h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<WineIcon className="size-3.5" aria-hidden />
				{SECTION_HEADING}
			</h3>
			{children}
		</section>
	);
}

export function AopCellarWines({
	aopId,
	aopNameJa,
	isAuthenticated,
}: {
	aopId: string;
	/** 空欄の案内文・ラベルに使うAOPの表示名 */
	aopNameJa: string;
	isAuthenticated: boolean;
}) {
	if (!isAuthenticated) {
		return (
			<SectionShell>
				<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<span>ログインすると登録したワインが表示されます</span>
					<Button asChild size="sm" variant="secondary">
						<Link to="/login">
							<LogInIcon className="size-3.5" aria-hidden />
							ログイン
						</Link>
					</Button>
				</div>
			</SectionShell>
		);
	}
	return <AuthedCellarWines aopId={aopId} aopNameJa={aopNameJa} />;
}

function AuthedCellarWines({
	aopId,
	aopNameJa,
}: {
	aopId: string;
	aopNameJa: string;
}) {
	const {
		data: entries,
		isPending,
		isError,
	} = useQuery({
		queryKey: cellarWinesKey(aopId),
		queryFn: () => listDrunkWinesByAop({ data: { aopId } }),
	});
	const [expanded, setExpanded] = useState(false);

	if (isError) {
		return (
			<SectionShell>
				<p className="text-sm text-destructive">
					登録したワインの取得に失敗しました
				</p>
			</SectionShell>
		);
	}
	if (isPending) {
		return (
			<SectionShell>
				<p className="text-sm text-muted-foreground">読み込み中...</p>
			</SectionShell>
		);
	}
	if (entries.length === 0) {
		return (
			<SectionShell>
				<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<span>{aopNameJa}のワインはまだ登録がありません。</span>
					<Button asChild size="sm" variant="secondary">
						<Link to="/cellar/new">
							<PlusIcon className="size-3.5" aria-hidden />
							記録する
						</Link>
					</Button>
				</div>
			</SectionShell>
		);
	}

	const collapsible = entries.length > COLLAPSE_THRESHOLD;
	const visible =
		collapsible && !expanded ? entries.slice(0, COLLAPSE_THRESHOLD) : entries;
	const hiddenCount = entries.length - visible.length;

	return (
		<SectionShell>
			<ul className="flex flex-col divide-y divide-border">
				{visible.map((entry) => (
					<li key={entry.id}>
						<CellarWineRow entry={entry} />
					</li>
				))}
			</ul>
			{collapsible && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					className="-ml-2 h-auto py-1 text-muted-foreground hover:text-foreground"
				>
					{expanded ? "折りたたむ" : `ほか${hiddenCount}件を表示`}
				</Button>
			)}
		</SectionShell>
	);
}

/**
 * 1件ぶんの行。行全体を編集画面へのリンクにする(マイセラー一覧のカードと同じ導線)。
 * 写真の alt は空にする — 直後に銘柄名が並ぶので、読み上げると名前が二重になる。
 */
function CellarWineRow({ entry }: { entry: DrunkWineEntry }) {
	const meta = [
		entry.vintage !== null ? `${entry.vintage}年` : undefined,
		WINE_STATUS_LABELS_JA[entry.status],
		entry.lastDrankOn ?? undefined,
	]
		.filter(Boolean)
		.join(" ・ ");

	return (
		<Link
			to="/cellar/$entryId/edit"
			params={{ entryId: entry.id }}
			className="flex items-center gap-2 rounded-md py-1.5 hover:bg-muted/60"
		>
			{entry.thumbUrls[0] ? (
				<img
					// 写真差し替え時にR2キーが同じでも再取得させるキャッシュバスタ
					// (マイセラー一覧と同じ扱い)
					src={`${entry.thumbUrls[0]}?v=${entry.updatedAt}`}
					alt=""
					className="size-9 shrink-0 rounded object-cover"
					loading="lazy"
					decoding="async"
					width={36}
					height={36}
				/>
			) : (
				<span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted">
					<WineIcon className="size-4 text-muted-foreground/40" aria-hidden />
				</span>
			)}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm">{entry.name}</span>
				<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
					{meta && <span className="truncate">{meta}</span>}
					{entry.lastRating !== null && (
						<RatingStars rating={entry.lastRating} />
					)}
				</span>
			</span>
		</Link>
	);
}
