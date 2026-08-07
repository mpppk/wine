import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import {
	ApplicationServerKeys,
	generatePushHTTPRequest,
	setWebCrypto,
} from "webpush-webcrypto";
import { db } from "#/db";
import { pushSubscription } from "#/db/schema";
import { logError, logInfo, logWarn } from "#/lib/logger";
import {
	isGonePushStatus,
	type PushNotificationPayload,
	type PushSubscriptionInput,
} from "#/lib/push/notification";

// Web Push の購読管理と送信(Issue #466)。
//
// 本文の暗号化と VAPID JWT は `webpush-webcrypto` に任せる。依存ゼロで WebCrypto だけを
// 使い、**送信そのものは自分で fetch する**形なので Workers に載る。自前で書かない理由は
// 「送ったつもりで届かない」壊れ方をこの環境では検出できないため(ヘッドレス Chromium が
// プッシュ購読を作れない。#466 参照)。
//
// ⚠️ **暗号化は `aesgcm`(draft-04)であって RFC 8291 の `aes128gcm` ではない。**
// 調べた範囲では Workers で動く Web Push ライブラリ(`webpush-webcrypto` /
// `@block65/webcrypto-web-push`)はどちらも draft-04 のままで、`aes128gcm` にするには
// 自前実装しか選択肢が無い——それはこのライブラリを選んだ理由と正面から矛盾する。
//
// 実害が出るとすれば「プッシュサービスが draft-04 の受け入れをやめたとき、送信は 2xx の
// まま通知だけ届かなくなる」形。**配信が確認できないときは、まずここを疑うこと。**
// 移行が必要になったら `aes128gcm` 対応のライブラリへ差し替える(encoding が変わったことは
// push-service.workers.test.ts が検知する)。
//
// **通知は付随物**という位置づけを全体に貫く: 送信の失敗はジョブの終端化にも購読の
// 保存にも影響させない。届かないことより、届かないせいで解析結果が失われるほうが悪い。

// **WebCrypto を明示的に渡す**。ライブラリの既定は「モジュール評価時に `self.crypto` が
// あれば拾う」で、無ければ使用時に throw する。workerd では `self` が居るので今は拾えるが、
// **これは型でもテストでも守られていない前提**であり、外れたときの壊れ方が「ビルドは通る
// のに送信時に毎回 throw」——つまり CI が緑のまま実機だけ壊れる(#184/#178 と同じ類型)。
// 明示的に渡せば前提そのものが消える。
setWebCrypto(crypto);

/** VAPID の連絡先。プッシュサービスが送信元に問い合わせるための識別子(RFC 8292)。 */
const VAPID_SUBJECT = "mailto:niboshiporipori@gmail.com";

/**
 * 通知の保持時間(秒)。プッシュサービスは端末がオフラインの間これだけ保持する。
 *
 * 解析結果は消えないので長く持たせてもよいが、**丸1日後に届く「解析が終わりました」は
 * もはや行動につながらない**(利用者はとっくにアプリを開いている)。半日にしておく。
 */
const PUSH_TTL_SECONDS = 12 * 60 * 60;

/**
 * Web Push が使える環境か(= VAPID 鍵が両方設定されているか)。
 *
 * **UI の出し分けとサーバ側の送信が同じ判定を見る**ようにする単一の判定口。片方だけを
 * 見て出し分けると、鍵の無い環境で購読トグルだけ出て「押しても何も起きない」になる。
 */
export function isWebPushConfigured(): boolean {
	return !!env.VAPID_PUBLIC_KEY?.trim() && !!env.VAPID_PRIVATE_KEY?.trim();
}

/** クライアントが購読を作るのに要る公開鍵。無効な環境では null。 */
export function webPushPublicKey(): string | null {
	if (!isWebPushConfigured()) return null;
	return env.VAPID_PUBLIC_KEY.trim();
}

/**
 * 購読を登録する。**同じ endpoint は上書きする**(同じ端末の再購読)。
 *
 * endpoint に unique を張ってあるので、別ユーザが同じ endpoint を主張してきた場合は
 * 所有者ごと入れ替わる——これは正しい: 同じブラウザで別アカウントにログインし直した
 * ケースで、通知の宛先も新しいユーザに移るべき。
 */
export async function savePushSubscription(
	userId: string,
	input: PushSubscriptionInput,
	userAgent?: string,
): Promise<void> {
	await db
		.insert(pushSubscription)
		.values({
			id: crypto.randomUUID(),
			userId,
			endpoint: input.endpoint,
			p256dh: input.p256dh,
			auth: input.auth,
			...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}),
		})
		.onConflictDoUpdate({
			target: pushSubscription.endpoint,
			set: {
				userId,
				p256dh: input.p256dh,
				auth: input.auth,
				...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}),
			},
		});
	logInfo("push subscription saved", { userId });
}

/** 購読を解除する(本人のもののみ)。存在しない endpoint は黙って成功扱い(冪等)。 */
export async function deletePushSubscription(
	userId: string,
	endpoint: string,
): Promise<void> {
	await db
		.delete(pushSubscription)
		.where(
			and(
				eq(pushSubscription.endpoint, endpoint),
				eq(pushSubscription.userId, userId),
			),
		);
}

/** 本人の購読が1件以上あるか(UI のトグルの初期状態)。 */
export async function hasPushSubscription(userId: string): Promise<boolean> {
	const rows = await db
		.select({ id: pushSubscription.id })
		.from(pushSubscription)
		.where(eq(pushSubscription.userId, userId))
		.limit(1);
	return rows.length > 0;
}

/**
 * 1ユーザの全購読へ通知を送る。**throw しない**——通知は付随物で、呼び出し元
 * (ジョブの終端化)を巻き込ませない。送れた件数を返す。
 *
 * 無効な購読(404/410)はその場で消す。それ以外の失敗は消さない: プッシュサービスの
 * 一時障害(429・5xx)で全ユーザの購読を消してしまうと、利用者は購読し直すまで
 * 通知が来なくなり、しかもそのことに気づけない。
 */
export async function sendPushToUser(
	userId: string,
	payload: PushNotificationPayload,
): Promise<number> {
	if (!isWebPushConfigured()) return 0;

	let subscriptions: (typeof pushSubscription.$inferSelect)[];
	try {
		subscriptions = await db
			.select()
			.from(pushSubscription)
			.where(eq(pushSubscription.userId, userId));
	} catch (e) {
		logError("failed to load push subscriptions", { userId, err: e });
		return 0;
	}
	if (subscriptions.length === 0) return 0;

	let keys: ApplicationServerKeys;
	try {
		// 鍵は毎回インポートする。isolate をまたいでキャッシュしても、鍵の入れ替え時に
		// 古い鍵で送り続ける経路を作るだけで、得られるのは1回ぶんの CPU 時間しかない。
		keys = await ApplicationServerKeys.fromJSON({
			publicKey: env.VAPID_PUBLIC_KEY.trim(),
			// isWebPushConfigured() で両方の存在を確認済み。型を絞るための ?? "".
			privateKey: (env.VAPID_PRIVATE_KEY ?? "").trim(),
		});
	} catch (e) {
		// 鍵の形式が壊れている = 全ユーザに送れない。設定を直すまで解消しないので記録する。
		logError("invalid VAPID keys; push disabled", { err: e });
		return 0;
	}

	const body = JSON.stringify(payload);
	let sent = 0;
	for (const subscription of subscriptions) {
		try {
			const {
				headers,
				body: encrypted,
				endpoint,
			} = await generatePushHTTPRequest({
				applicationServerKeys: keys,
				payload: body,
				target: {
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.p256dh, auth: subscription.auth },
				},
				adminContact: VAPID_SUBJECT,
				ttl: PUSH_TTL_SECONDS,
				urgency: "normal",
			});
			const res = await fetch(endpoint, {
				method: "POST",
				headers,
				body: encrypted,
			});
			if (res.ok) {
				sent += 1;
				await db
					.update(pushSubscription)
					.set({ lastNotifiedAt: new Date() })
					.where(eq(pushSubscription.id, subscription.id));
				continue;
			}
			if (isGonePushStatus(res.status)) {
				// 購読が解除済み・存在しない。こちらの行が古いので消す。
				await db
					.delete(pushSubscription)
					.where(eq(pushSubscription.id, subscription.id));
				logInfo("push subscription gone; removed", {
					userId,
					status: res.status,
				});
				continue;
			}
			// 一時的な失敗。**消さない**(次の通知で再試行される)。
			logWarn("push delivery failed", { userId, status: res.status });
		} catch (e) {
			// 暗号化・ネットワークの失敗。ここで throw すると呼び出し元(ジョブの終端化)を
			// 巻き込むので、記録だけ残して次の購読へ進む。
			logError("push delivery threw", { userId, err: e });
		}
	}
	return sent;
}
