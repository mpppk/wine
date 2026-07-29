import { useMutation } from "@tanstack/react-query";
import { EyeIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { adminStopImpersonating } from "#/server/admin";

/**
 * なりすまし(impersonation)中であることを常時知らせる帯(#116)。
 *
 * Header の中(sticky な `<header>` の1行目)に置く。独立した sticky 要素にすると
 * ヘッダーと top-0 を奪い合って重なるため、ヘッダーと同じ要素の内側に入れて
 * 「スクロールしても必ず見えている」を成立させる。
 *
 * なりすまし中は書き込みが server 側で一律拒否される(#/lib/admin/impersonation)。
 * この帯はその状態をユーザ(管理者)に伝えるためのもので、権限の実体ではない。
 */
export function ImpersonationBanner() {
	const { data: session } = authClient.useSession();
	const impersonatedBy = session?.session.impersonatedBy;

	const { mutate, isPending, error } = useMutation({
		mutationFn: () => adminStopImpersonating(),
		onSuccess: () => {
			// セッションCookieが管理者のものへ戻るため、SPA の再取得では足りない。
			// 管理画面へフル遷移してセッションを取り直す。
			window.location.assign("/admin");
		},
	});

	if (!impersonatedBy) return null;

	return (
		<div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-amber-900 dark:text-amber-200">
			<p className="text-xs font-medium sm:text-sm">
				<EyeIcon className="mr-1 inline size-4 align-text-bottom" aria-hidden />
				<strong>{session.user.name || session.user.email}</strong>{" "}
				としてなりすまし中です(閲覧のみ・書き込みは無効)
			</p>
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={isPending}
				onClick={() => mutate()}
			>
				{isPending ? "終了中..." : "なりすましを終了"}
			</Button>
			{error && (
				<p className="w-full text-center text-xs text-destructive">
					終了に失敗しました: {error.message}
				</p>
			)}
		</div>
	);
}
