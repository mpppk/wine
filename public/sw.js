// Web Push の Service Worker(Issue #466)。
//
// **ここでしかできないこと**だけを書く: バックグラウンドで push を受けて通知を出し、
// タップされたら該当タブへ送る。キャッシュ戦略やオフライン対応は持たない——
// このアプリは SSR + 署名付き画像で、SW にキャッシュを持たせると認可の効かない層に
// 個人の写真が残る経路を新設することになる。
//
// ペイロードの形は src/lib/push/notification.ts が SSOT。ここでは**表示に使う前に
// 形を確かめる**(古いデプロイが送った形も届きうるので、壊れた通知を出すより出さない)。

/** 通知アイコン。favicon を流用する(専用アセットを増やさない)。 */
const NOTIFICATION_ICON = "/favicon.ico";

self.addEventListener("install", () => {
	// 新しい SW を即座に有効化する。通知の文言や遷移先を直したとき、既存タブを
	// 閉じるまで古い SW が生き続けるのを避ける。
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	if (!event.data) return;

	let payload;
	try {
		payload = event.data.json();
	} catch {
		return;
	}
	// 最低限の形の確認。zod はここに持ち込めない(SW は素の JS で配信する)ので、
	// 表示に必要なフィールドの存在だけを見る。
	if (
		!payload ||
		typeof payload.title !== "string" ||
		typeof payload.body !== "string" ||
		typeof payload.url !== "string"
	) {
		return;
	}

	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: NOTIFICATION_ICON,
			// 同じジョブの通知を1つに畳む(再送や複数端末での重複を利用者に見せない)
			tag: typeof payload.tag === "string" ? payload.tag : undefined,
			data: { url: payload.url },
		}),
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
