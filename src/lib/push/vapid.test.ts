import { describe, expect, it } from "vitest";
import {
	createVapidAuthorization,
	decodeJwtClaims,
	importVapidPrivateKey,
	importVapidPublicKey,
	parseVapidAuthorization,
	verifyJwtSignature,
} from "./vapid";

// VAPID の署名を**署名検証まで**確かめる(Issue #466)。
//
// 本文の暗号化を捨ててここだけにした理由がこれ: 署名は自分で検証できるので、
// 「実際に届くか」を見なくても正しさが閉じる。暗号化のほうは復号できる相手が要り、
// この環境ではその相手(実ブラウザの購読)を用意できない。

/** このテスト専用に生成した鍵ペア。 */
const PUBLIC_KEY =
	"BDE48t-TAG4btM4wIJqbb9ooz-n4VjJXAF8IjNoCoTzlYWtF7l9rAIq57GceUM2aWL98Ckq6PaVo2TXJDSZJMPU";
const PRIVATE_KEY =
	"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKJM-c2C7YuOPa4LE6Zx-95oQVz-kIEdHrZI8OL5l1KmhRANCAAQxOPLfkwBuG7TOMCCam2_aKM_p-FYyVwBfCIzaAqE85WFrRe5fawCKuexnHlDNmli_fApKuj2laNk1yQ0mSTD1";

const SUBJECT = "mailto:test@example.test";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const NOW_MS = 1_780_000_000_000;

async function sign(overrides: { endpoint?: string; nowMs?: number } = {}) {
	return createVapidAuthorization({
		endpoint: overrides.endpoint ?? ENDPOINT,
		privateKey: await importVapidPrivateKey(PRIVATE_KEY),
		publicKeyBase64url: PUBLIC_KEY,
		subject: SUBJECT,
		nowMs: overrides.nowMs ?? NOW_MS,
	});
}

describe("createVapidAuthorization", () => {
	it("RFC 8292 の形式(vapid t=…, k=…)で返す", async () => {
		const header = await sign();
		const parsed = parseVapidAuthorization(header);
		expect(parsed).not.toBeNull();
		expect(parsed?.publicKey).toBe(PUBLIC_KEY);
		// JWT は3パート
		expect(parsed?.jwt.split(".")).toHaveLength(3);
	});

	it("署名が公開鍵で検証できる", async () => {
		// **これがこの設計の要点**。届くかどうかを見なくても、署名の正しさはここで閉じる。
		const parsed = parseVapidAuthorization(await sign());
		const publicKey = await importVapidPublicKey(PUBLIC_KEY);
		expect(await verifyJwtSignature(parsed?.jwt ?? "", publicKey)).toBe(true);
	});

	it("改竄された JWT は検証に失敗する", async () => {
		const parsed = parseVapidAuthorization(await sign());
		const [header, , signature] = (parsed?.jwt ?? "").split(".");
		// クレームだけ差し替える(exp を伸ばす等)と署名が合わなくなること。
		const tampered = `${header}.${btoa('{"aud":"https://evil.test"}')
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "")}.${signature}`;
		const publicKey = await importVapidPublicKey(PUBLIC_KEY);
		expect(await verifyJwtSignature(tampered, publicKey)).toBe(false);
	});

	it("aud は endpoint の**オリジン**(パスを含めない)", async () => {
		// パスまで入れるとプッシュサービスに弾かれる。
		const parsed = parseVapidAuthorization(await sign());
		const claims = decodeJwtClaims(parsed?.jwt ?? "");
		expect(claims?.aud).toBe("https://fcm.googleapis.com");
	});

	it("endpoint ごとに aud が変わる", async () => {
		// プッシュサービスは aud が自分自身かを見る。購読ごとに署名し直す必要がある。
		const mozilla = parseVapidAuthorization(
			await sign({
				endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
			}),
		);
		expect(decodeJwtClaims(mozilla?.jwt ?? "")?.aud).toBe(
			"https://updates.push.services.mozilla.com",
		);
	});

	it("sub に連絡先、exp に有効期限を載せる", async () => {
		const parsed = parseVapidAuthorization(await sign());
		const claims = decodeJwtClaims(parsed?.jwt ?? "");
		expect(claims?.sub).toBe(SUBJECT);
		// 12時間後(秒)。RFC 8292 の上限は24時間で、短いほど漏れたときの窓が狭い。
		expect(claims?.exp).toBe(Math.floor(NOW_MS / 1000) + 12 * 60 * 60);
	});

	it("ヘッダは ES256", async () => {
		const parsed = parseVapidAuthorization(await sign());
		const headerPart = (parsed?.jwt ?? "").split(".")[0] ?? "";
		const decoded = JSON.parse(
			atob(headerPart.replace(/-/g, "+").replace(/_/g, "/")),
		);
		expect(decoded).toEqual({ typ: "JWT", alg: "ES256" });
	});

	it("署名は JOSE 形式(生の r||s = 64バイト)", async () => {
		// WebCrypto の ECDSA は既にこの形式を返す。Node の crypto は DER を返すので、
		// そちらのコードを持ち込むと二重変換になる。
		const parsed = parseVapidAuthorization(await sign());
		const sig = (parsed?.jwt ?? "").split(".")[2] ?? "";
		const bytes = atob(sig.replace(/-/g, "+").replace(/_/g, "/"));
		expect(bytes.length).toBe(64);
	});
});

describe("importVapidPrivateKey", () => {
	it("壊れた鍵は throw する", async () => {
		// 呼び出し側が「全ユーザに送れない」として記録するための境界。
		await expect(importVapidPrivateKey("not-a-key")).rejects.toThrow();
	});
});

describe("parseVapidAuthorization", () => {
	it("形式が違えば null", () => {
		for (const header of [
			"WebPush abc.def.ghi", // draft-04 の形式
			"vapid t=onlytoken",
			"Bearer abc",
			"",
		]) {
			expect(parseVapidAuthorization(header)).toBeNull();
		}
	});
});
