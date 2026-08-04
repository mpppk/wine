import { createFileRoute, redirect } from "@tanstack/react-router";

// 「写真からまとめて登録」は「ワインを記録」(/cellar/new)に統合した。写真から
// 始める流れがそちらの既定になったので、このURLは転送だけを担う。
//
// ルートごと消さないのは、ブックマーク・共有リンク・アドレス欄からの再訪を 404 に
// しないため。`/cellar/import/history`(登録履歴)は別ルートなので影響しない。
export const Route = createFileRoute("/cellar/import")({
	beforeLoad: () => {
		throw redirect({ to: "/cellar/new" });
	},
});
