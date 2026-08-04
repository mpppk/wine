import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ImagesIcon } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { DrunkWineForm } from "#/components/cellar/DrunkWineForm";
import { PhotoRegisterWizard } from "#/components/cellar/PhotoRegisterWizard";
import {
	MAX_HANDOFF_PHOTOS,
	type ManualFormStart,
} from "#/components/cellar/single-wine-handoff";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import { getWineListAnalysisPlan } from "#/server/ai";
import { getImportBatch, listPlaces } from "#/server/place";

// ワインの登録画面。**写真から始める**のが既定の流れで、手入力は「手動で入力」を
// 選んだときだけ出す。以前は「ワインを記録」(手入力)と「写真からまとめて登録」の
// 2画面に分かれていたが、記録の起点は写真を撮ることなので入口をここに統合した。
//
// 2つのモードは排他だが、**写真ウィザードはアンマウントしない**(hidden にする)。
// 解析済みの候補はAIクレジットを消費して得たものなので、記録フォームへ切り替えて
// から戻ったときに消えていてはいけない(#238)。逆に記録フォームは戻る操作で
// 破棄する——こちらは作り直しにクレジットがかからないため。

/**
 * 一括登録履歴からの再解析(#427)。`?rescan=<batchId>` で開くと、そのバッチの
 * 保存済み写真・場所・見かけた日を初期値にしてウィザードが立ち上がる。
 * **元バッチは書き換えない**(確定すると新しいバッチができる)。
 */
const searchSchema = z.object({
	rescan: z.string().min(1).max(80).optional(),
});

export const Route = createFileRoute("/cellar/new")({
	validateSearch: searchSchema,
	beforeLoad: requireAuthBeforeLoad,
	loaderDeps: ({ search }) => ({ rescan: search.rescan }),
	loader: async ({ deps }) => {
		const [places, wineListPlan, rescanBatch] = await Promise.all([
			listPlaces(),
			getWineListAnalysisPlan(),
			// 他人のバッチ・存在しないIDはサービス層が 404 にする。写真が無いバッチは
			// 再解析しようがないので、素の登録画面として開く(URL直打ちの逃げ道)。
			deps.rescan
				? getImportBatch({ data: { batchId: deps.rescan } }).catch(() => null)
				: null,
		]);
		return { places, wineListPlan, rescanBatch };
	},
	component: CellarNewPage,
});

function CellarNewPage() {
	const { places, wineListPlan, rescanBatch } = Route.useLoaderData();
	// 写真の実体が無いバッチ(登録だけして写真アップロードに失敗した回)は
	// 再解析の材料が無いので、通常の登録画面として扱う
	const rescan =
		rescanBatch && rescanBatch.photoUrls.length > 0
			? {
					batchId: rescanBatch.id,
					photoUrls: rescanBatch.photoUrls,
					placeId: rescanBatch.placeId,
					seenOn: rescanBatch.seenOn,
					createdAt: rescanBatch.createdAt,
				}
			: undefined;
	const navigate = useNavigate();
	// 単体の記録フォームへ切り替えているときだけ荷物が入る。null = 写真ウィザード。
	// 解析が使えない環境では写真の経路自体が無いので、最初から手入力で開く。
	const [manual, setManual] = useState<ManualFormStart | null>(() =>
		wineListPlan.route
			? null
			: {
					files: [],
					droppedPhotoCount: 0,
					reason: "manual_choice",
					discardedSightingInput: false,
				},
	);
	const [confirmBackOpen, setConfirmBackOpen] = useState(false);

	// 写真ウィザードへ戻れるのは、解析が使える環境で切り替えてきたときだけ
	const canGoBackToPhotos = wineListPlan.route !== null && manual !== null;

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
				<h1 className="text-2xl font-bold">
					{rescan ? "一括登録をやり直す" : "ワインを記録"}
				</h1>
			</div>

			{wineListPlan.route && (
				<div hidden={manual !== null}>
					<PhotoRegisterWizard
						places={places}
						route={wineListPlan.route}
						rescan={rescan}
						active={manual === null}
						onSwitchToManual={setManual}
					/>
				</div>
			)}

			{manual && (
				<div className="flex flex-col gap-6">
					<ManualNotice
						start={manual}
						{...(canGoBackToPhotos
							? { onBack: () => setConfirmBackOpen(true) }
							: {})}
					/>
					<DrunkWineForm
						initialValues={manual.values}
						initialPhotoFiles={manual.files}
						autoAnalyzeLabel={manual.reason === "single_wine"}
						onSaved={() => {
							void navigate({ to: "/cellar" });
						}}
					/>
				</div>
			)}

			{/*
			  戻る操作は必ず確認を挟む。フォームの未保存判定はフォームの中にあり、
			  外から見えない——「入力済みかどうか」を二重管理するより、稀な操作である
			  戻るを常に確認するほうが取り違えが起きない。
			*/}
			<Dialog open={confirmBackOpen} onOpenChange={setConfirmBackOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>写真からの登録に戻りますか?</DialogTitle>
						<DialogDescription>
							記録フォームに入力した内容は破棄されます。写真の選択と解析結果はそのまま残ります。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmBackOpen(false)}
						>
							入力を続ける
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								setConfirmBackOpen(false);
								setManual(null);
							}}
						>
							破棄して戻る
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}

/**
 * 記録フォームの上に出す案内。写真ウィザードから何を引き継ぎ、何を引き継げなかったかを
 * 伝え、写真の経路へ戻る導線を出す。
 */
function ManualNotice({
	start,
	onBack,
}: {
	start: ManualFormStart;
	onBack?: () => void;
}) {
	const fromSingleWine = start.reason === "single_wine";
	// 手入力しか選べない環境(解析が使えない)では案内することが何も無い
	if (!fromSingleWine && !onBack && start.files.length === 0) return null;

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm">
			{fromSingleWine ? (
				<p>
					1本のワインの写真と判定したため、記録フォームに切り替えました。写真から読み取った内容を入力し、エチケットの詳細な解析を実行しています。
				</p>
			) : (
				start.files.length > 0 && (
					<p>選んだ写真を{start.files.length}枚引き継ぎました。</p>
				)
			)}
			{start.droppedPhotoCount > 0 && (
				<p className="text-muted-foreground">
					写真は先頭{MAX_HANDOFF_PHOTOS}枚のみ引き継いでいます(
					{start.droppedPhotoCount}
					枚は1件のワインに保存できる上限を超えたため対象外)。
				</p>
			)}
			{start.discardedSightingInput && (
				<p className="text-muted-foreground">
					写真の場所・撮影日は記録フォームには引き継がれません。見かけた記録として残す場合は、写真からの登録に戻ってください。
				</p>
			)}
			{onBack && (
				<div>
					<Button type="button" variant="outline" size="sm" onClick={onBack}>
						<ImagesIcon className="size-4" aria-hidden />
						写真からの登録に戻る
					</Button>
				</div>
			)}
		</div>
	);
}
