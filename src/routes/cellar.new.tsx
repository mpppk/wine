import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";
import { DrunkWineForm } from "#/components/cellar/DrunkWineForm";
import { takeSingleWineHandoff } from "#/components/cellar/single-wine-handoff";
import { Button } from "#/components/ui/button";
import { requireAuthBeforeLoad } from "#/lib/route-guard";

export const Route = createFileRoute("/cellar/new")({
	beforeLoad: requireAuthBeforeLoad,
	component: CellarNewPage,
});

function CellarNewPage() {
	const navigate = useNavigate();
	// 写真からの一括登録が「1本のワインのエチケットだった」と判定して渡してきた荷物
	// (#416)。**マウント時に1回だけ取り出す**(取り出したら箱は空になる)。通常の
	// 「ワインを記録」で開いたときは null で、従来どおり空のフォームになる。
	const [handoff] = useState(takeSingleWineHandoff);

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6 flex items-center gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					aria-label="マイセラーへ戻る"
				>
					<Link to="/cellar">
						<ArrowLeftIcon className="size-4" />
					</Link>
				</Button>
				<h1 className="text-2xl font-bold">ワインを記録</h1>
			</div>
			{handoff && (
				<p className="mb-4 rounded-lg border border-border bg-muted/40 p-4 text-sm">
					写真から読み取った内容を入力しました。
					{handoff.droppedPhotoCount > 0 &&
						`写真は先頭${handoff.files.length}枚のみ引き継いでいます(${handoff.droppedPhotoCount}枚は対象外)。`}
				</p>
			)}
			<DrunkWineForm
				initialValues={handoff?.values}
				initialPhotoFiles={handoff?.files}
				autoAnalyzeLabel={!!handoff}
				onSaved={() => {
					void navigate({ to: "/cellar" });
				}}
			/>
		</main>
	);
}
