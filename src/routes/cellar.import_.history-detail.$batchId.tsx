import { createFileRoute, redirect } from "@tanstack/react-router";
import { ImportBatchDetailView } from "#/components/cellar/ImportBatchDetail";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import { getImportBatchDetail } from "#/server/place";

// 一括登録バッチ1件の詳細(Issue #572)。履歴の行から「どんな写真が
// アップロードされたか、どんな値が設定されたか」を辿る読み取り専用画面。
// 分析完了後の一覧(レビューカード)と同等の項目を、保存済みの値から出す。
//
// **履歴の下ではなく兄弟ルート**に置く。履歴の下(`history/$batchId`)に置くと
// 履歴画面の子になり、履歴画面が <Outlet /> を持たないため詳細が出ない
// (本リポジトリに親子描画の前例は無い)。

export const Route = createFileRoute("/cellar/import_/history-detail/$batchId")(
	{
		beforeLoad: requireAuthBeforeLoad,
		loader: async ({ params }) => {
			try {
				return await getImportBatchDetail({
					data: { batchId: params.batchId },
				});
			} catch (e) {
				// 存在しない/他ユーザのバッチは履歴へ逃がす(存在の有無を漏らさない)
				if (
					e instanceof Error &&
					e.message.includes("Import batch not found")
				) {
					throw redirect({ to: "/cellar/import/history" });
				}
				throw e;
			}
		},
		component: CellarImportBatchDetailPage,
	},
);

function CellarImportBatchDetailPage() {
	const detail = Route.useLoaderData();
	return <ImportBatchDetailView detail={detail} />;
}
