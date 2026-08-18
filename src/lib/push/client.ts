import type { PushSubscriptionInput } from "#/lib/push/notification";

// ブラウザ側の購読手続き(Issue #466)。**この画面がどこまで進めるか**の判定と、
// 購読オブジェクトをサーバへ送れる形に落とすところだけを持つ。
//
// 保存(D1)は server fn 側。ここは `navigator` / `PushManager` に触る部分に閉じており、
// jsdom のユニットテストからは呼ばない(ブラウザ実機でしか意味を持たない層)。

/** Service Worker の登録先。`public/sw.js` がそのまま配信される。 */
const SERVICE_WORKER_URL = "/sw.js";

/**
 * このブラウザが Web Push を扱えるか。
 *
 * **UI の出し分けはこの1関数を見る**。`serviceWorker` はあるが `PushManager` が無い
 * (iOS の非 PWA Safari 等)環境が実在するので、両方を確かめる。
 */
export function isPushSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		typeof window !== "undefined" &&
		"PushManager" in window &&
		"Notification" in window
	);
}

/** 通知の許可状態。`denied` はブラウザ設定からしか戻せないので、UI で案内を変える。 */
export function pushPermission(): NotificationPermission | null {
	if (!isPushSupported()) return null;
	return Notification.permission;
}

/**
 * base64url の VAPID 公開鍵を `applicationServerKey` が要求する形へ。
 *
 * 戻りを `ArrayBuffer` にするのは型の都合。`Uint8Array` の `buffer` は
 * `ArrayBufferLike`(= `SharedArrayBuffer` を含む)なので、`BufferSource` を要求する
 * `subscribe()` にそのままは渡せない。
 */
function decodeVapidKey(base64url: string): ArrayBuffer {
	const padded = base64url
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(base64url.length / 4) * 4, "=");
	const raw = atob(padded);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes.buffer as ArrayBuffer;
}

/** `PushSubscription` をサーバへ送る形へ。鍵が取れなければ null(購読として使えない)。 */
function toSubscriptionInput(
	subscription: PushSubscription,
): PushSubscriptionInput | null {
	const p256dh = subscription.getKey("p256dh");
	const auth = subscription.getKey("auth");
	if (!p256dh || !auth) return null;
	return {
		endpoint: subscription.endpoint,
		p256dh: base64url(p256dh),
		auth: base64url(auth),
	};
}

function base64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Service Worker を登録して購読を作る。**許可を求めるのはここ**なので、
 * 利用者の操作(トグル)を起点にしてのみ呼ぶこと——ページ表示だけで権限ダイアログを
 * 出すのは嫌われるし、ブラウザによっては黙って拒否される。
 *
 * 失敗はすべて Error で返す(呼び出し側が文言を画面に出す)。
 */
export async function subscribeToPush(
	vapidPublicKey: string,
): Promise<PushSubscriptionInput> {
	if (!isPushSupported()) {
		throw new Error("このブラウザは通知に対応していません");
	}
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new Error(
			"通知が許可されませんでした。ブラウザの設定から許可すると受け取れます。",
		);
	}
	const registration =
		await navigator.serviceWorker.register(SERVICE_WORKER_URL);
	await navigator.serviceWorker.ready;

	// 既存の購読があれば使い回す。**作り直すと endpoint が変わり**、サーバ側に
	// 送れない古い行が残る(410 で掃除されるまで無駄な送信が走る)。
	const existing = await registration.pushManager.getSubscription();
	const subscription =
		existing ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: decodeVapidKey(vapidPublicKey),
		}));

	const input = toSubscriptionInput(subscription);
	if (!input) throw new Error("購読の鍵を取得できませんでした");
	return input;
}

/**
 * ブラウザ側の購読を解除し、その endpoint を返す(サーバの行を消すのに要る)。
 * 購読が無ければ null。
 */
export async function unsubscribeFromPush(): Promise<string | null> {
	if (!isPushSupported()) return null;
	const registration =
		await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
	if (!registration) return null;
	const subscription = await registration.pushManager.getSubscription();
	if (!subscription) return null;
	const { endpoint } = subscription;
	await subscription.unsubscribe();
	return endpoint;
}
