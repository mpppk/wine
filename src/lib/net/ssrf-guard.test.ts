import { describe, expect, it } from "vitest";
import { isAllowedExternalHost } from "./ssrf-guard";

// 共通SSRFガード(#545)のSSOT固定テスト。3経路(fetch-title / remote-photo /
// push購読)が同じ判定を見ることをここで保証する。ポリシーを変えるときは
// このファイルと各経路のテストを同時に更新すること。

describe("isAllowedExternalHost", () => {
	it("公開ホスト名は許可する", () => {
		for (const h of [
			"example.com",
			"cdn.example.com",
			"fcm.googleapis.com",
			"updates.push.services.mozilla.com",
		]) {
			expect(isAllowedExternalHost(h), h).toBe(true);
			expect(isAllowedExternalHost(h, { allowPublicIpLiteral: true }), h).toBe(
				true,
			);
		}
	});

	it("大文字・末尾ドットは正規化して受ける", () => {
		expect(isAllowedExternalHost("Example.COM")).toBe(true);
		expect(isAllowedExternalHost("example.com.")).toBe(true);
		expect(isAllowedExternalHost("LOCALHOST")).toBe(false);
	});

	it("localhost / 特別用途TLD を両モードで弾く", () => {
		for (const h of [
			"localhost",
			"foo.localhost",
			"printer.local",
			"intranet.internal",
			"intranet.localdomain",
			"router.home.arpa",
			"home.arpa",
		]) {
			expect(isAllowedExternalHost(h), h).toBe(false);
			expect(
				isAllowedExternalHost(h, { allowPublicIpLiteral: true }),
				`${h} (allowIp)`,
			).toBe(false);
		}
	});

	it("既定(厳しい側)は公開IPリテラルも弾く", () => {
		for (const h of ["8.8.8.8", "1.1.1.1", "[2001:db8::1]", "2001:db8::1"]) {
			expect(isAllowedExternalHost(h), h).toBe(false);
		}
	});

	it("オプトイン時は公開IPリテラルのみ許可し、内部帯は弾く", () => {
		const opts = { allowPublicIpLiteral: true } as const;
		// 公開IPは許可(参考リンクの既存テスト固定)
		expect(isAllowedExternalHost("8.8.8.8", opts)).toBe(true);
		expect(isAllowedExternalHost("[2001:db8::1]", opts)).toBe(true);
		// 内部IPv4帯は弾く
		for (const h of [
			"127.0.0.1",
			"10.0.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"172.16.0.1",
			"172.31.255.255",
			"0.0.0.0",
		]) {
			expect(isAllowedExternalHost(h, opts), h).toBe(false);
		}
		// IPv6 の内部帯は弾く
		for (const h of [
			"[::1]",
			"[::]",
			"[fc00::1]",
			"[fd12:3456::1]",
			"[fe80::1]",
		]) {
			expect(isAllowedExternalHost(h, opts), h).toBe(false);
		}
		// IPv4-mapped で内部アドレスを偽装しても弾く
		expect(isAllowedExternalHost("[::ffff:127.0.0.1]", opts)).toBe(false);
		expect(isAllowedExternalHost("[::ffff:169.254.169.254]", opts)).toBe(false);
	});

	it("空ホストは弾く", () => {
		expect(isAllowedExternalHost("")).toBe(false);
		expect(isAllowedExternalHost("", { allowPublicIpLiteral: true })).toBe(
			false,
		);
	});
});
