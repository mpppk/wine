import type { AdminUserDetail } from "#/lib/services/admin-service";
import { adminImpersonateUser } from "#/server/admin";
import { DangerAction } from "./DangerAction";

/**
 * 対象ユーザへのなりすまし(impersonation)を開始する操作(#116)。
 *
 * 自分自身は不可(banUser と同じ理由でサーバ側でも 400 にする)。管理者を対象にした
 * なりすましは better-auth が拒否するため、UI 側でも先に理由を出して無効化する
 * (押してから 403 になるより意図が伝わる)。
 */
export function ImpersonationControl({
	detail,
	isSelf,
}: {
	detail: AdminUserDetail;
	isSelf: boolean;
}) {
	const isTargetAdmin = detail.user.role === "admin";
	const disabled = isSelf || isTargetAdmin;
	const disabledNote = isSelf
		? "自分自身になりすますことはできません。"
		: isTargetAdmin
			? "管理者になりすますことはできません。"
			: undefined;

	return (
		<DangerAction
			label="このユーザとして表示(なりすまし)"
			buttonVariant="outline"
			confirmTitle="なりすましを開始しますか?"
			confirmBody={`${detail.user.name || detail.user.email} としてアプリを閲覧します。なりすまし中は閲覧のみ可能で、書き込み操作(クイズ回答・セラー編集・AI利用など)はすべて拒否されます。`}
			doneMessage="なりすましを開始しました。"
			disabled={disabled}
			disabledNote={disabledNote}
			mutationFn={(reason) =>
				adminImpersonateUser({ data: { userId: detail.user.id, reason } })
			}
			// セッションCookieが対象ユーザのものへ差し替わるので、SPA の再取得では足りない。
			onCompleted={() => window.location.assign("/")}
		/>
	);
}
