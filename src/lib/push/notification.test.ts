import { describe, expect, it } from "vitest";
import {
	buildLabelAnalysisDonePayload,
	isGonePushStatus,
	pushNotificationPayloadSchema,
	pushSubscriptionInputSchema,
} from "./notification";

describe("buildLabelAnalysisDonePayload", () => {
	it("アプリ内バッジと同じ受け取り導線へ送る", () => {
		const payload = buildLabelAnalysisDonePayload("job-1");
		// 通知から入ってもバッジから入っても既読化のされ方が同じになるよう、
		// 遷移先は /cellar/new?labelJob=<jobId> に合流させる(#462 の導線)。
		expect(payload.url).toBe("/cellar/new?labelJob=job-1");
		expect(payload.kind).toBe("label_analysis_done");
	});

	it("jobId をURLエンコードする", () => {
		// jobId は UUID なので実際にエスケープは要らないが、URL を組む以上
		// 素の連結にはしない(将来IDの形が変わったときに壊れる)。
		expect(buildLabelAnalysisDonePayload("a b&c").url).toBe(
			"/cellar/new?labelJob=a%20b%26c",
		);
	});

	it("解析結果を通知本文に載せない", () => {
		const payload = buildLabelAnalysisDonePayload("job-1");
		// 通知はロック画面に出る。「何を飲む/買うか」が他人に見える状態を作らない。
		expect(payload.title + payload.body).not.toMatch(/Chablis|銘柄|生産者/);
	});

	it("同じジョブの通知は端末側で1つに畳めるタグを持つ", () => {
		expect(buildLabelAnalysisDonePayload("job-1").tag).toBe(
			"label-analysis-job-1",
		);
	});

	it("組んだペイロードは Service Worker 側の検証を通る", () => {
		// 送信側と表示側で形が食い違うと「送っているのに表示されない」という
		// 最も気づきにくい壊れ方をする。両方を同じスキーマで固定する。
		expect(
			pushNotificationPayloadSchema.safeParse(
				buildLabelAnalysisDonePayload("job-1"),
			).success,
		).toBe(true);
	});
});

describe("pushSubscriptionInputSchema", () => {
	const valid = {
		endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		p256dh: "BPk1",
		auth: "aGk",
	};

	it("https の endpoint を受け取る", () => {
		expect(pushSubscriptionInputSchema.safeParse(valid).success).toBe(true);
	});

	it("https 以外の endpoint を拒否する", () => {
		// endpoint は外部から渡され、送信時にそこへ fetch する。任意スキームを通すと
		// サーバを任意先へのリクエスト発火装置にできてしまう。
		for (const endpoint of [
			"http://example.test/push",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"not-a-url",
		]) {
			expect(
				pushSubscriptionInputSchema.safeParse({ ...valid, endpoint }).success,
			).toBe(false);
		}
	});

	it("内部向けホストの endpoint を拒否する(共通SSRFガード・#545)", () => {
		// https でも内部アドレス・特別用途TLDへは送らない。許可リスト化(#634)の
		// 前段として、少なくとも3経路共通のガードは通す。
		for (const endpoint of [
			"https://localhost/push",
			"https://foo.localhost/push",
			"https://printer.local/push",
			"https://intranet.internal/push",
			"https://127.0.0.1/push",
			"https://10.0.0.1/push",
			"https://169.254.169.254/latest/meta-data",
			"https://8.8.8.8/push",
			"https://[::1]/push",
		]) {
			expect(
				pushSubscriptionInputSchema.safeParse({ ...valid, endpoint }).success,
				endpoint,
			).toBe(false);
		}
		// 既知のプッシュサービスは通す
		for (const endpoint of [
			"https://fcm.googleapis.com/fcm/send/abc",
			"https://updates.push.services.mozilla.com/wpush/v2/xyz",
		]) {
			expect(
				pushSubscriptionInputSchema.safeParse({ ...valid, endpoint }).success,
				endpoint,
			).toBe(true);
		}
	});

	it("鍵が空なら拒否する", () => {
		expect(
			pushSubscriptionInputSchema.safeParse({ ...valid, p256dh: "" }).success,
		).toBe(false);
		expect(
			pushSubscriptionInputSchema.safeParse({ ...valid, auth: "" }).success,
		).toBe(false);
	});
});

describe("isGonePushStatus", () => {
	it("404 / 410 だけを「購読が無効」とみなす", () => {
		expect(isGonePushStatus(404)).toBe(true);
		expect(isGonePushStatus(410)).toBe(true);
	});

	it("一時的な失敗では購読を消さない", () => {
		// プッシュサービスの一時障害(429・5xx)で全ユーザの購読が飛ぶと、
		// 利用者は購読し直すまで通知が来ず、しかもそのことに気づけない。
		for (const status of [201, 400, 401, 403, 429, 500, 502, 503]) {
			expect(isGonePushStatus(status)).toBe(false);
		}
	});
});
