// Web Push の Service Worker(Issue #466)。
//
// **ここでしかできないこと**だけを書く: バックグラウンドで push を受けて通知を出し、
// タップされたら該当タブへ送る。キャッシュ戦略やオフライン対応は持たない——
// このアプリは SSR + 署名付き画像で、SW にキャッシュを持たせると認可の効かない層に
// 個人の写真が残る経路を新設することになる。
//
// **プッシュには本文が載っていない**。サーバは「何かあった」だけを送り、表示する内容は
// ここからアプリのAPIへ取りに行く。そうすることで本文の暗号化(RFC 8291)が丸ごと不要に
// なり、同時に文言と遷移先がサーバ側の TS(テストできる場所)に残る。
//
// 同一オリジンの fetch なのでセッションCookieが乗る。ログアウト後やセッション切れでは
// 401 が返るので、その場合は汎用文言にフォールバックする。

const NOTIFICATION_API = "/api/label-analysis-jobs?notification=1";

/** 通知アイコン。favicon を流用する(専用アセットを増やさない)。 */
const NOTIFICATION_ICON = "/favicon.ico";

/**
 * 取得できなかったときに出す内容。
 *
 * **通知を出さない選択肢は無い**——`userVisibleOnly: true` で購読しているので、push を
 * 受けたら必ず何かを表示しなければならない(黙って捨てると、ブラウザによっては購読を
 * 取り消される)。行き先はマイセラーにしておけば、解析中バッジから状況が分かる。
 */
const FALLBACK_NOTIFICATION = {
	title: "エチケットの解析が完了しました",
	body: "マイセラーを開くと結果を受け取れます。",
	url: "/cellar",
	tag: "label-analysis",
};

self.addEventListener("install", () => {
	// 新しい SW を即座に有効化する。通知の文言や遷移先を直したとき、既存タブを
	// 閉じるまで古い SW が生き続けるのを避ける。
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

/** 表示する通知を決める。API が取れない・受け取り待ちが無い場合は汎用文言。 */
async function resolveNotification() {
	try {
		const res = await fetch(NOTIFICATION_API, { credentials: "same-origin" });
		if (!res.ok) return FALLBACK_NOTIFICATION;
		const body = await res.json();
		const notification = body?.notification;
		// サーバ側(src/lib/push/notification.ts)が組んだ形。表示に必要なフィールドの
		// 存在だけ確かめる——壊れた通知を出すより、汎用文言のほうがまし。
		if (
			notification &&
			typeof notification.title === "string" &&
			typeof notification.body === "string" &&
			typeof notification.url === "string"
		) {
			return notification;
		}
		return FALLBACK_NOTIFICATION;
	} catch {
		// オフライン・セッション切れなど。表示はしなければならない。
		return FALLBACK_NOTIFICATION;
	}
}

self.addEventListener("push", (event) => {
	event.waitUntil(
		resolveNotification().then((notification) =>
			self.registration.showNotification(notification.title, {
				body: notification.body,
				icon: NOTIFICATION_ICON,
				// 同じジョブの通知を1つに畳む(再送や複数端末での重複を利用者に見せない)
				tag:
					typeof notification.tag === "string" ? notification.tag : undefined,
				data: { url: notification.url },
			}),
		),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = event.notification.data?.url;
	if (typeof url !== "string") return;

	event.waitUntil(
		(async () => {
			const clientList = await self.clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			// **既に開いているタブがあればそれを使う**。新しいタブを開くと、入力途中の
			// フォームを持つタブと2枚並ぶことになる。
			for (const client of clientList) {
				if ("focus" in client) {
					await client.focus();
					if ("navigate" in client) {
						await client.navigate(url).catch(() => {});
					}
					return;
				}
			}
			await self.clients.openWindow(url);
		})(),
	);
});
