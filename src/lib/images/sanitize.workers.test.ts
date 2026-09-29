import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExifFromBytes } from "#/components/cellar/photo-exif";
import {
	AVATAR_MAX_DIMENSION,
	deleteStaleAvatars,
	sanitizeAvatarImage,
} from "./sanitize";

// アバター画像のEXIF除去と旧拡張子オブジェクトの掃除(#641)。
// IMAGESバインディングはテストプールに無いため、ai-service.workers.test.ts と
// 同じく env.IMAGES をスタブして差し替える。

/** GPS付きJPEG(Orientation=6)。SOI→APP0→APP1(Exif)→SOS→EOIの最小構成。 */
const GPS_JPEG_BASE64 =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/4QDGRXhpZgAASUkqAAgAAAADABIBAwABAAAABgAAAGmHBAABAAAAMgAAACWIBAABAAAAWAAAAAAAAAABAAOQAgAUAAAARAAAAAAAAAAyMDI0OjA1OjA2IDEyOjM0OjU2AAQAAQACAAIAAABOAAAAAgAFAAMAAACOAAAAAwACAAIAAABFAAAABAAFAAMAAACmAAAAAAAAACMAAAABAAAAJwAAAAEAAAAeAAAAAQAAAIsAAAABAAAAKQAAAAEAAAAeAAAAAQAAAP/aAAYBAQAAPwCqu//Z";

function gpsJpeg(): Uint8Array {
	return Uint8Array.from(atob(GPS_JPEG_BASE64), (c) => c.charCodeAt(0));
}

/** コメント付きGIF(アニメ要素なしの最小構成)。 */
function gifWithComment(): Uint8Array {
	const bytes: number[] = [];
	const ascii = (s: string) => {
		for (const c of s) bytes.push(c.charCodeAt(0));
	};
	ascii("GIF89a");
	bytes.push(0x01, 0x00, 0x01, 0x00, 0x70, 0x00, 0x00);
	bytes.push(0x21, 0xfe, 0x03, 0x68, 0x69, 0x21, 0x00);
	bytes.push(
		0x2c,
		0,
		0,
		0,
		0,
		0x01,
		0,
		0x01,
		0,
		0,
		0x02,
		0x02,
		0xaa,
		0xbb,
		0x00,
	);
	bytes.push(0x3b);
	return new Uint8Array(bytes);
}

afterEach(() => {
	delete (env as unknown as { IMAGES?: unknown }).IMAGES;
	vi.restoreAllMocks();
});

/** IMAGESバインディングを差し替え、変換結果として canned を返させる。 */
function stubImages(
	canned: Uint8Array<ArrayBuffer>,
	captured?: { transform?: unknown; output?: unknown },
): void {
	(env as unknown as { IMAGES: unknown }).IMAGES = {
		input: () => ({
			transform: (options: unknown) => {
				if (captured) captured.transform = options;
				return {
					output: (outputOptions: unknown) => {
						if (captured) captured.output = outputOptions;
						return {
							response: () => new Response(canned),
						};
					},
				};
			},
		}),
	};
}

describe("sanitizeAvatarImage", () => {
	it("IMAGESがあれば再エンコード結果を返す(生バイトを保存しない)", async () => {
		const canned = new Uint8Array([9, 9, 9]);
		const captured: { transform?: unknown; output?: unknown } = {};
		stubImages(canned, captured);

		const result = await sanitizeAvatarImage(gpsJpeg(), "image/jpeg");

		expect(result).toEqual(canned);
		// 長辺上限の縮小(scale-down)で再エンコードしている
		expect(captured.transform).toEqual({
			width: AVATAR_MAX_DIMENSION,
			height: AVATAR_MAX_DIMENSION,
			fit: "scale-down",
		});
		expect(captured.output).toEqual({ format: "image/jpeg" });
	});

	it("GPS付きJPEGのEXIFを除去する(IMAGESが無い環境のフォールバック)", async () => {
		// 前提: 入力は実際にGPS・日時を持つ
		expect(parseExifFromBytes(gpsJpeg()).gps).not.toBeNull();

		const result = await sanitizeAvatarImage(gpsJpeg(), "image/jpeg");

		expect(parseExifFromBytes(result)).toEqual({
			takenOn: null,
			gps: null,
		});
	});

	it("GIFはIMAGESがあっても可逆除去する(再エンコードしない)", async () => {
		stubImages(new Uint8Array([9, 9, 9]));

		const result = await sanitizeAvatarImage(gifWithComment(), "image/gif");

		// スタブの canned ではなく、コメントの落ちたGIFが返る
		expect(result).not.toEqual(new Uint8Array([9, 9, 9]));
		expect(new TextDecoder().decode(result)).not.toContain("hi!");
		expect(result.at(-1)).toBe(0x3b);
	});
});

describe("deleteStaleAvatars", () => {
	async function objectExists(key: string): Promise<boolean> {
		return (await env.AVATARS.head(key)) !== null;
	}

	it("他拡張子の旧オブジェクトだけを消す(新キー・他人は残す)", async () => {
		const userId = `stale-${crypto.randomUUID()}`;
		const neighborId = `${userId}-other`;
		const keepKey = `avatars/${userId}.jpg`;
		const staleKey = `avatars/${userId}.png`;
		const neighborKey = `avatars/${neighborId}.png`;
		await env.AVATARS.put(staleKey, new Uint8Array([1]));
		await env.AVATARS.put(keepKey, new Uint8Array([2]));
		await env.AVATARS.put(neighborKey, new Uint8Array([3]));
		try {
			await deleteStaleAvatars(userId, keepKey);

			expect(await objectExists(staleKey)).toBe(false);
			expect(await objectExists(keepKey)).toBe(true);
			// 接頭辞が前方一致する他人(`avatars/${userId}...`)は巻き込まない
			expect(await objectExists(neighborKey)).toBe(true);
		} finally {
			await env.AVATARS.delete([keepKey, neighborKey]);
		}
	});

	it("R2の失敗でもthrowしない(best-effort)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(env.AVATARS, "list").mockRejectedValueOnce(
			new Error("R2 unavailable"),
		);

		await expect(
			deleteStaleAvatars("some-user", "avatars/some-user.jpg"),
		).resolves.toBeUndefined();
	});
});
