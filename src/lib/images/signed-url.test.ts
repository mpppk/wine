import { describe, expect, it } from "vitest";
import {
	expiresAtFrom,
	imageKeyFromPath,
	imagePathForKey,
	importImageSigningKey,
	isPrivateImageKey,
	ownerOfPrivateImageKey,
	privateImagePrefixForUser,
	SIGNED_IMAGE_URL_TTL_MS,
	signImageKey,
	verifyImageSignature,
} from "#/lib/images/signed-url";

// 非公開のマイセラー写真(wines/)の認可の土台。ここが壊れると、URLを知る誰でも
// 他人の写真を無認証で読めていた #149 の状態に戻る。

const NOW = 1_800_000_000_000;
const KEY = "wines/user-1/entry-1/photo-1.jpg";

async function key(
	material = "test-signing-key-material-32bytes",
): Promise<CryptoKey> {
	return importImageSigningKey(new TextEncoder().encode(material));
}

describe("isPrivateImageKey", () => {
	it("wines/ 配下だけを非公開扱いにする", () => {
		expect(isPrivateImageKey(KEY)).toBe(true);
		// アバターは公開プロフィール画像なので従来どおり無認証で配信する
		expect(isPrivateImageKey("avatars/user-1.png")).toBe(false);
	});
});

describe("ownerOfPrivateImageKey", () => {
	it("wines/{userId}/{entryId}/{photoId}.{ext} から所有者を取り出す", () => {
		expect(ownerOfPrivateImageKey(KEY)).toBe("user-1");
	});

	it("想定の階層でないキーは所有者を決められないので null を返す", () => {
		// セッション認可に使う値なので、曖昧なら「判定不能」に倒す(誤って
		// 他人のIDを所有者と見なさない)。
		expect(ownerOfPrivateImageKey("wines/flat-legacy.jpg")).toBeNull();
		expect(ownerOfPrivateImageKey("wines/user-1/entry-1/a/b.jpg")).toBeNull();
		expect(ownerOfPrivateImageKey("avatars/user-1.png")).toBeNull();
	});
});

describe("privateImagePrefixForUser", () => {
	it("そのユーザの写真キーだけに前方一致する", () => {
		const prefix = privateImagePrefixForUser("user-1");
		expect(KEY.startsWith(prefix)).toBe(true);
		// IDの前方一致で他人のキーを巻き込まない(user-1 と user-10)
		expect("wines/user-10/entry-1/photo-1.jpg".startsWith(prefix)).toBe(false);
		expect("avatars/user-1.png".startsWith(prefix)).toBe(false);
	});

	// 所有者判定と削除範囲がズレると、消したはずの個人データがR2に残る(#252)
	it("接頭辞に一致するキーの所有者は必ずそのユーザになる", () => {
		expect(ownerOfPrivateImageKey(KEY)).toBe("user-1");
		expect(KEY.startsWith(privateImagePrefixForUser("user-1"))).toBe(true);
	});
});

describe("imagePathForKey / imageKeyFromPath", () => {
	it("R2キーと配信パスを相互変換する", () => {
		expect(imagePathForKey(KEY)).toBe(`/api/images/${KEY}`);
		expect(imageKeyFromPath(`/api/images/${KEY}`)).toBe(KEY);
	});

	it("接頭辞を持たない文字列はそのまま返す", () => {
		expect(imageKeyFromPath(KEY)).toBe(KEY);
	});
});

describe("expiresAtFrom", () => {
	it("TTL 後の UNIX 秒を返す", () => {
		expect(expiresAtFrom(NOW)).toBe(
			Math.floor((NOW + SIGNED_IMAGE_URL_TTL_MS) / 1000),
		);
	});
});

describe("verifyImageSignature", () => {
	it("自分で署名したURLは有効期限内なら通る", async () => {
		const k = await key();
		const exp = expiresAtFrom(NOW);
		const sig = await signImageKey(k, KEY, exp);
		expect(await verifyImageSignature(k, KEY, String(exp), sig, NOW)).toBe(
			true,
		);
	});

	it("有効期限を過ぎたら通らない", async () => {
		const k = await key();
		const exp = expiresAtFrom(NOW);
		const afterExpiry = (exp + 1) * 1000;
		const sig = await signImageKey(k, KEY, exp);
		expect(
			await verifyImageSignature(k, KEY, String(exp), sig, afterExpiry),
		).toBe(false);
	});

	it("別のキーへ署名を付け替えられない", async () => {
		// 署名対象にR2キーを含めているので、自分の写真の署名で他人の写真は読めない。
		const k = await key();
		const exp = expiresAtFrom(NOW);
		const sig = await signImageKey(k, KEY, exp);
		expect(
			await verifyImageSignature(
				k,
				"wines/user-2/entry-9/photo-9.jpg",
				String(exp),
				sig,
				NOW,
			),
		).toBe(false);
	});

	it("有効期限だけ書き換えても通らない", async () => {
		const k = await key();
		const exp = expiresAtFrom(NOW);
		const sig = await signImageKey(k, KEY, exp);
		expect(
			await verifyImageSignature(k, KEY, String(exp + 86_400), sig, NOW),
		).toBe(false);
	});

	it("別の鍵で作った署名は通らない", async () => {
		const exp = expiresAtFrom(NOW);
		const sig = await signImageKey(
			await key("attacker-key-material-xxxxxxxxxx"),
			KEY,
			exp,
		);
		expect(
			await verifyImageSignature(await key(), KEY, String(exp), sig, NOW),
		).toBe(false);
	});

	it("exp / sig が欠けている・書式が壊れている場合は通らない", async () => {
		const k = await key();
		const exp = expiresAtFrom(NOW);
		const sig = await signImageKey(k, KEY, exp);
		expect(await verifyImageSignature(k, KEY, null, sig, NOW)).toBe(false);
		expect(await verifyImageSignature(k, KEY, String(exp), null, NOW)).toBe(
			false,
		);
		expect(await verifyImageSignature(k, KEY, "not-a-number", sig, NOW)).toBe(
			false,
		);
		// base64url 以外の文字が混ざる署名は atob で例外にせず false に倒す
		expect(await verifyImageSignature(k, KEY, String(exp), "***", NOW)).toBe(
			false,
		);
	});
});
