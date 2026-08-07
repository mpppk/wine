import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { pushSubscription } from "#/db/schema";
import { logError, logInfo, logWarn } from "#/lib/logger";
import {
	isGonePushStatus,
	type PushSubscriptionInput,
} from "#/lib/push/notification";
import {
	createVapidAuthorization,
	importVapidPrivateKey,
} from "#/lib/push/vapid";

// Web Push の購読管理と送信(Issue #466)。
//
// **本文を送らない**(payload-less push)。プッシュサービスへは「何かあった」だけを伝え、
// 通知の文言と遷移先は Service Worker がアプリのAPI(`?notification=1`)から取る。
//
// なぜこの形か:
//
//  - 本文を送るなら RFC 8291 の暗号化が要る(プッシュサービスは中継する第三者なので、
//    中身を読ませないため)。その実装は ECDH + HKDF + AES-GCM + フレーミングで、
//    正しさを閉じるには「実際に届いて復号できること」を見るしかない。**この環境では
//    それができない**(ヘッドレス Chromium がプッシュ購読を作れない。#466)
//  - Workers で動くライブラリは調べた範囲でどちらも draft-04(`aesgcm`)のままで、
//    RFC 8291 の `aes128gcm` にするには自前実装しか無かった
//  - 本文が無ければ暗号化する対象も無い。残るのは VAPID(標準的な ES256 の JWT)だけで、
//    **そちらは署名検証まで自動テストで閉じられる**
//
// 代償は通知のたびにネットワーク往復が1回増えること。解析の完了は数十秒に1回の
// できごとなので、これは払ってよい。
//
// **通知は付随物**という位置づけを全体に貫く: 送信の失敗はジョブの終端化にも購読の
// 保存にも影響させない。届かないことより、届かないせいで解析結果が失われるほうが悪い。

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
 *
 * **`p256dh` / `auth` は今の送信経路では使わない**(本文を送らないため)。それでも受け取って
 * 保存しているのは、本文を送る形へ切り替えたくなったときに**利用者に購読し直させずに済む**
 * ようにするため。どちらもその購読へ送るためだけの値で、endpoint と揃って初めて意味を持つ。
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
 * 1ユーザの全購読へ「何かあった」を送る(本文なし)。**throw しない**——通知は付随物で、
 * 呼び出し元(ジョブの終端化)を巻き込ませない。送れた件数を返す。
 *
 * 無効な購読(404/410)はその場で消す。それ以外の失敗は消さない: プッシュサービスの
 * 一時障害(429・5xx)で全ユーザの購読を消してしまうと、利用者は購読し直すまで
 * 通知が来なくなり、しかもそのことに気づけない。
 */
export async function sendPushToUser(userId: string): Promise<number> {
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

	const publicKey = env.VAPID_PUBLIC_KEY.trim();
	let privateKey: CryptoKey;
	try {
		// 鍵は毎回インポートする。isolate をまたいでキャッシュしても、鍵の入れ替え時に
		// 古い鍵で送り続ける経路を作るだけで、得られるのは1回ぶんの CPU 時間しかない。
		privateKey = await importVapidPrivateKey(
			(env.VAPID_PRIVATE_KEY ?? "").trim(),
		);
	} catch (e) {
		// 鍵の形式が壊れている = 全ユーザに送れない。設定を直すまで解消しないので記録する。
		logError("invalid VAPID keys; push disabled", { err: e });
		return 0;
	}

	let sent = 0;
	for (const subscription of subscriptions) {
		try {
			// **VAPID の `aud` は endpoint のオリジン**なので、購読ごとに署名し直す。
			const authorization = await createVapidAuthorization({
				endpoint: subscription.endpoint,
				privateKey,
				publicKeyBase64url: publicKey,
				subject: VAPID_SUBJECT,
			});
			const res = await fetch(subscription.endpoint, {
				method: "POST",
				headers: {
					Authorization: authorization,
					TTL: String(PUSH_TTL_SECONDS),
					// 本文が無いことを明示する。付けないと一部のプッシュサービスが
					// 「本文があるのに Content-Encoding が無い」と解釈して 400 を返す。
					"Content-Length": "0",
					Urgency: "normal",
				},
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
			// 署名・ネットワークの失敗。ここで throw すると呼び出し元(ジョブの終端化)を
			// 巻き込むので、記録だけ残して次の購読へ進む。
			logError("push delivery threw", { userId, err: e });
		}
	}
	return sent;
}
