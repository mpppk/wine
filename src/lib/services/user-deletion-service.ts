import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import { stripeClient } from "#/lib/billing/stripe-client";
import {
	avatarPrefixForUser,
	privateImagePrefixForUser,
} from "#/lib/images/signed-url";
import { logError, logInfo } from "#/lib/logger";

// ユーザ削除に伴う後始末(#252)。
//
// D1 のドメインテーブルは全て user への ON DELETE cascade を張っているので
// better-auth が user 行を消せば連動して消える。一方で **D1 の外にあるもの**は
// 誰も消さない:
//
//  - Stripe のサブスクリプション → アプリ側のユーザだけが消えて課金が継続する
//  - R2 のオブジェクト(マイセラー写真・アバター) → キーに userId を含む個人データが残る
//  - subscription 行 → referenceId は FK の無い文字列参照なので孤児化する
//
// 後始末を呼び出し側(管理API・将来の退会導線)ごとに書くと必ず適用漏れするため、
// ここに集約して auth.ts の databaseHooks から1箇所で呼ぶ。

/** R2 の list は1回あたり最大1000件。打ち切られたらカーソルで続きを取る */
const R2_LIST_LIMIT = 1000;

/**
 * 接頭辞に一致する R2 オブジェクトを全件削除し、削除件数を返す。
 * list は truncated のときだけ cursor を持つので、それを辿って全ページ消す
 * (1000件で打ち切ると写真の多いユーザのデータが残る)。
 */
async function deleteObjectsByPrefix(prefix: string): Promise<number> {
	let cursor: string | undefined;
	let deleted = 0;
	do {
		const listed = await env.AVATARS.list({
			prefix,
			cursor,
			limit: R2_LIST_LIMIT,
		});
		const keys = listed.objects.map((o) => o.key);
		// R2 は複数キーの一括削除に対応し、存在しないキーは黙って無視される
		if (keys.length > 0) await env.AVATARS.delete(keys);
		deleted += keys.length;
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return deleted;
}

/**
 * ユーザの Stripe サブスクリプションを即時解約する。解約した subscription ID を返す。
 *
 * status で絞らず「stripeSubscriptionId を持つ行」を全て試す。D1 の status は
 * webhook 経由でしか更新されず、webhook の取りこぼしで実際は active なのに
 * D1 上は incomplete/canceled に見えることがあるためで、**D1 の状態を信じて
 * 解約をスキップすると課金が残る**。既に解約済み・存在しない subscription への
 * cancel は Stripe が 4xx を返すので、それは無視して続行する。
 */
async function cancelStripeSubscriptions(userId: string): Promise<string[]> {
	const rows = await db
		.select({ stripeSubscriptionId: subscription.stripeSubscriptionId })
		.from(subscription)
		.where(eq(subscription.referenceId, userId));
	const ids = [
		...new Set(
			rows
				.map((r) => r.stripeSubscriptionId)
				.filter((id): id is string => !!id),
		),
	];

	const canceled: string[] = [];
	for (const id of ids) {
		try {
			await stripeClient.subscriptions.cancel(id);
			canceled.push(id);
		} catch (e) {
			// 既に解約済み・Stripe 側に存在しない場合は後始末として達成済みなので通す。
			// それ以外(認証エラー・ネットワーク・レート制限)は課金が残るため呼び出し側へ投げ、
			// ユーザ削除自体を中止させる。
			if (isAlreadyGoneOnStripe(e)) {
				logInfo("stripe subscription already inactive on delete", {
					userId,
					stripeSubscriptionId: id,
				});
				continue;
			}
			throw e;
		}
	}
	return canceled;
}

/** 「Stripe 側に無い/既に解約済み」= 後始末としては達成済みとみなせるエラーか */
function isAlreadyGoneOnStripe(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, statusCode } = error as {
		code?: unknown;
		statusCode?: unknown;
	};
	if (code === "resource_missing") return true;
	// 解約済みサブスクへの cancel は 400 invalid_request_error になる
	return statusCode === 404 || statusCode === 400;
}

/**
 * ユーザ削除の**前**に行う後始末。失敗したら throw して削除自体を中止させる。
 *
 * Stripe の解約をここに置くのは、**先にユーザを消してしまうと解約に必要な
 * 紐付け(subscription.referenceId)が失われ、課金だけが残る**ため。中止すれば
 * ユーザは残るので、管理者は原因を直して再実行できる。
 */
export async function cleanupBeforeUserDelete(userId: string): Promise<void> {
	const canceled = await cancelStripeSubscriptions(userId);
	const removed = await db
		.delete(subscription)
		.where(eq(subscription.referenceId, userId))
		.returning({ id: subscription.id });
	logInfo("user delete cleanup (before)", {
		userId,
		canceledSubscriptions: canceled.length,
		removedSubscriptionRows: removed.length,
	});
}

/**
 * ユーザ削除の**後**に行う後始末(R2 の個人データ削除)。
 *
 * 削除の前に置かない理由: 前に置くと、この後の user 行削除が失敗したときに
 * 「生きているユーザの写真だけ消えた」状態になり復旧できない。後なら失敗しても
 * 残るのは「消し損ねた個人データ」で、userId をログに残せば後から消せる。
 * よって失敗しても throw せず error ログに倒す(削除自体は既に成立している)。
 */
export async function cleanupAfterUserDelete(userId: string): Promise<void> {
	try {
		const photos = await deleteObjectsByPrefix(
			privateImagePrefixForUser(userId),
		);
		const avatars = await deleteObjectsByPrefix(avatarPrefixForUser(userId));
		logInfo("user delete cleanup (after)", {
			userId,
			deletedPhotoObjects: photos,
			deletedAvatarObjects: avatars,
		});
	} catch (e) {
		// ここで throw すると既に消えたユーザの削除APIが 500 になり、実態
		// (ユーザは消えた・R2 に残骸がある)と食い違う。userId を残して復旧可能にする。
		logError("failed to delete user objects from R2", { userId, err: e });
	}
}
