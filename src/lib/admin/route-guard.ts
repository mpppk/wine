import { redirect } from "@tanstack/react-router";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import { isAdminSession } from "./guard";

/**
 * 管理ルートの `beforeLoad` 共通処理(#161)。未ログインは /login、管理者でない
 * (または BAN 中)は / へ黙って戻す。3つの管理ルート(admin.index / admin.$userId /
 * admin.bulk-credit)で同一の beforeLoad をコピーしていたのを集約し、判定条件は
 * `isAdminSession`(server function 境界の adminMiddleware と共有)に委ねる。
 *
 * 未ログイン判定は認証必須ルート共通の `requireAuthBeforeLoad` に委ねる(#259)。
 * こうしておくと「ログイン後に元のページへ戻す」等を足したとき、管理ルートだけ
 * 取り残されることがない。
 */
export async function requireAdminBeforeLoad(): Promise<void> {
	const session = await requireAuthBeforeLoad();
	// 非管理者・BAN中には管理画面の存在を示さず、トップへ黙って戻す。
	if (!isAdminSession(session)) {
		throw redirect({ to: "/" });
	}
}
