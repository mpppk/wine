import { useBlocker } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";

/**
 * 未保存の入力がある状態での離脱を警告する共通ガード(#238)。
 *
 * 2種類の離脱を1箇所で押さえる:
 *  - アプリ内遷移(ヘッダのリンク・⌘Kパレット・ブラウザバック)は `useBlocker` で止め、
 *    確認ダイアログを出す
 *  - タブを閉じる・リロード・外部サイトへの遷移は `enableBeforeUnload` でブラウザ標準の
 *    確認に委ねる(文言はブラウザ固定・アプリからは変えられない)
 *
 * 判定を bool ではなく **関数** で受け取るのは、保存成功の直後に同じ tick で遷移する
 * ケースがあるため。bool を prop で渡すと「保存で dirty が解けた」再レンダリングが
 * 遷移に間に合わず、自分の保存後遷移を自分でブロックしてしまう。
 * 呼び出し側は保存完了時に ref を倒し、この関数から false を返せばよい。
 */
export function UnsavedChangesGuard({
	shouldBlock,
	title = "入力内容が保存されていません",
	description = "このページを離れると、入力した内容は失われます。",
	stayLabel = "編集を続ける",
	leaveLabel = "破棄して移動",
}: {
	shouldBlock: () => boolean;
	title?: string;
	description?: string;
	stayLabel?: string;
	leaveLabel?: string;
}) {
	const blocker = useBlocker({
		shouldBlockFn: () => shouldBlock(),
		enableBeforeUnload: () => shouldBlock(),
		withResolver: true,
	});

	return (
		<Dialog
			open={blocker.status === "blocked"}
			onOpenChange={(open) => {
				// 閉じる操作(Esc・オーバーレイ)は「編集を続ける」と同じ扱い。
				if (!open) blocker.reset?.();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" onClick={() => blocker.reset?.()}>
						{stayLabel}
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => blocker.proceed?.()}
					>
						{leaveLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
