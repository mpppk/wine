import { z } from "zod";

// Web Push の通知ペイロードとブラウザ購読の語彙(Issue #466)。
//
// `cloudflare:workers` に依存しない純粋な形だけを置く——**Service Worker とサーバの
// 両方から読む**ため。ペイロードの形が2箇所に書かれると、片方だけ増やしたフィールドが
// 黙って落ちる(送っているのに表示されない、という最も気づきにくい壊れ方をする)。

/** 購読タグ。将来べつの通知を足すとき、Service Worker 側の出し分けの軸になる。 */
export const PUSH_NOTIFICATION_KINDS = ["label_analysis_done"] as const;
export type PushNotificationKind = (typeof PUSH_NOTIFICATION_KINDS)[number];

/**
 * 表示する通知の中身。
 *
 * **プッシュサービスには載せない**(#466)。本文なしで「何かあった」だけを送り、
 * Service Worker がアプリのAPI(`?notification=1`)からこれを取って表示する。
 * そうすることで暗号化が要らなくなり(送るものが無い)、同時に**文言と遷移先が
 * サーバ側の TS に残る**——プレーンJSの Service Worker に散らすと、テストの効かない
 * ところで文言や導線がドリフトする。
 *
 * 銘柄名のような解析結果は入れない——通知はロック画面に出る前提なので、
 * 「何を飲む/買うか」が他人に見える状態を作らない。
 *
 * `url` はクリック時に開く先。アプリ内バッジと**同じ受け取り導線**
 * (`/cellar/new?labelJob=<jobId>`)に合流させることで、通知から入っても
 * バッジから入っても既読化のされ方が同じになる。
 */
export interface PushNotificationPayload {
	kind: PushNotificationKind;
	title: string;
	body: string;
	url: string;
	/** 同じジョブの通知を端末側で1つに畳むためのタグ */
	tag: string;
}

/**
 * Service Worker 側の検証。**古いデプロイが送った形**も届きうるので、
 * 表示に使う前に形を確かめる(壊れた通知を出すより、出さないほうがまし)。
 */
export const pushNotificationPayloadSchema = z.object({
	kind: z.enum(PUSH_NOTIFICATION_KINDS),
	title: z.string().min(1),
	body: z.string().min(1),
	url: z.string().min(1),
	tag: z.string().min(1),
});

/** エチケット解析の完了通知を組む。文言は1箇所に置く(送信側と表示側で食い違わせない)。 */
export function buildLabelAnalysisDonePayload(
	jobId: string,
): PushNotificationPayload {
	return {
		kind: "label_analysis_done",
		title: "エチケットの解析が完了しました",
		// 銘柄名は載せない。通知の中身が端末のロック画面に出ることを前提に、
		// 「何を飲む/買うか」が他人に見える状態を作らない。
		body: "タップすると解析結果を反映した記録フォームが開きます。",
		url: `/cellar/new?labelJob=${encodeURIComponent(jobId)}`,
		tag: `label-analysis-${jobId}`,
	};
}

/**
 * 通知が来たとき、いまの状態から表示すべき内容を決める(#466)。
 *
 * **プッシュは「何かあった」しか伝えない**ので、何を見せるかは Service Worker が
 * 取りに来た時点の状態で決まる。受け取り待ちが複数あっても通知は1つに畳む——
 * 「3件終わりました」と出しても、開いた先で受け取れるのは古い1件だけなので、
 * 件数を出すと導線と食い違う。
 *
 * 受け取り待ちが無ければ null。**通知を出さない**という選択はできない
 * (`userVisibleOnly: true` は必ず何かの表示を要求する)ので、その判断は
 * Service Worker 側の汎用文言に委ねる。
 */
export function buildPendingNotification(badge: {
	readyCount: number;
	nextReadyJobId?: string;
}): PushNotificationPayload | null {
	if (badge.readyCount === 0 || !badge.nextReadyJobId) return null;
	return buildLabelAnalysisDonePayload(badge.nextReadyJobId);
}

/** ブラウザの `PushSubscription` から、サーバへ送る形を取り出したもの。 */
export interface PushSubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
}

/**
 * 購読の受け取り口の検証。`endpoint` は**外部から渡されるURL**なので、
 * ここで https のみに絞る(送信は endpoint へ fetch するため、任意スキームを
 * 通すとサーバを任意先へのリクエスト発火装置にできてしまう)。
 */
export const pushSubscriptionInputSchema = z.object({
	endpoint: z
		.string()
		.min(1)
		.max(2000)
		.refine(
			(value) => {
				try {
					return new URL(value).protocol === "https:";
				} catch {
					return false;
				}
			},
			{ message: "endpoint は https のURLである必要があります" },
		),
	p256dh: z.string().min(1).max(500),
	auth: z.string().min(1).max(500),
});

/**
 * 購読が無効になったことをプッシュサービスが返すステータス。
 *
 * `404` = そんな購読は無い / `410 Gone` = 購読が解除された。どちらも**こちらの行が
 * 古い**ので消してよい。それ以外(429・5xx 等)は一時的な失敗なので消さない——
 * 消してしまうと、プッシュサービスの一時障害で全ユーザの購読が飛ぶ。
 */
export function isGonePushStatus(status: number): boolean {
	return status === 404 || status === 410;
}
