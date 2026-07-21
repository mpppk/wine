import { env, waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

// このルートが配信してよいR2オブジェクトは「アバター」と「ワイン写真」だけ。
// splat をそのままキーにして任意オブジェクトを読み出せると、将来 AVATARS バケットに
// 非公開データを置いた瞬間に無認証で全て読める設計になる。想定プレフィックス以外・
// 親ディレクトリ参照(..)・二重スラッシュ・想定外拡張子は 404 で拒否する。
// - avatars/{userId}.{ext}
// - wines/{userId}/{entryId}/{photoId}.{ext}(旧フラット形式のキーも許容)
function isAllowedImageKey(key: string): boolean {
	if (key.includes("..") || key.startsWith("/") || key.includes("//")) {
		return false;
	}
	if (!/^(avatars|wines)\//.test(key)) return false;
	return /^[A-Za-z0-9._/-]+\.(jpe?g|png|webp|gif)$/.test(key);
}

export const Route = createFileRoute("/api/images/$")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const r2Key = (params as Record<string, string>)._splat;

				if (!r2Key || !isAllowedImageKey(r2Key)) {
					return new Response("Not found", { status: 404 });
				}

				// エッジキャッシュ(コロ単位の共有キャッシュ)。画像URLは差し替え時に
				// ?v=updatedAt が変わるため、完全なリクエストURLをそのままキャッシュキーに
				// できる(バージョンが変われば別エントリになり自然に失効する)。これにより
				// 別ユーザ・別ブラウザからの同一アバター閲覧が毎回 Worker 起動 + R2 GET
				// (クラスB課金)になるのを防ぐ。Cache-Control の immutable はブラウザ
				// キャッシュにしか効かないため、共有キャッシュはここで明示的に持たせる。
				// `caches.default` は Workers 固有(DOM lib の CacheStorage 型には無い)の
				// ため型を明示する。tsconfig の lib に DOM が入っており global の
				// CacheStorage が DOM 側で解決されるので、ここでキャストする。
				const cache = (caches as unknown as { default: Cache }).default;
				const cached = await cache.match(request);
				if (cached) return cached;

				const ifNoneMatch = request.headers.get("If-None-Match");
				const object = await env.AVATARS.get(r2Key);

				if (!object) {
					return new Response("Not found", { status: 404 });
				}

				const etag = `"${object.etag}"`;
				if (ifNoneMatch === etag) {
					return new Response(null, { status: 304 });
				}

				const response = new Response(object.body, {
					headers: {
						"Content-Type":
							object.httpMetadata?.contentType ?? "application/octet-stream",
						// 保存済み Content-Type と実体が食い違っても、ブラウザに MIME を
						// 推測させない(スクリプト実行等の意図しない解釈を防ぐ多層防御)。
						"X-Content-Type-Options": "nosniff",
						"Cache-Control": "public, max-age=31536000, immutable",
						ETag: etag,
						"Content-Length": String(object.size),
					},
				});

				// レスポンス返却をブロックしないよう、エッジキャッシュへの保存は
				// waitUntil でバックグラウンド実行する(body は clone で複製)。
				waitUntil(cache.put(request, response.clone()));
				return response;
			},
		},
	},
});
