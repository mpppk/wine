import { redirect } from "@tanstack/react-router";
import { requireAuthBeforeLoad } from "#/lib/route-guard";

/**
 * 管理ルートの `beforeLoad` 共通処理(#161)。未ログインは /login、管理者でない
 * (または BAN 中)は / へ黙って戻す。3つの管理ルート(admin.index / admin.$userId /
 * admin.bulk-credit)で同一の beforeLoad をコピーしていたのを集約し、判定条件は
 * `isAdminSession`(server function 境界の adminMiddleware と共有)に委ねる。
 *
 * 未ログイン判定は認証必須ルート共通の `requireAuthBeforeLoad` に委ねる(#259)。
 * こうしておくと「ログイン後に元のページへ戻す」等を足したとき、管理ルートだけ
 * 取り残されることがない。
 *
 * 管理者判定そのものは `RouteSession.isAdmin` に載っている。この値はサーバ側で
 * `isAdminSession`(server function 境界の `adminMiddleware` と共有する SSOT)が算出した
 * ものなので、判定条件は従来どおり1箇所のまま(#177)。`role`/`banned` をクライアントへ
 * 出さずに済ませるための形で、ここでの再判定は不要。
 *
 * **このガードは画面の出し分けでしかない**。管理操作の認可は server function 境界の
 * `adminMiddleware` が生セッションで行う。
 */
export async function requireAdminBeforeLoad(): Promise<void> {
	const session = await requireAuthBeforeLoad();
	// 非管理者・BAN中には管理画面の存在を示さず、トップへ黙って戻す。
	if (!session.isAdmin) {
		throw redirect({ to: "/" });
	}
}
