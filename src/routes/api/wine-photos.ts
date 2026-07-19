import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTOS_PER_ENTRY,
} from "#/lib/drunk-wine/photo";
import {
	type PhotoLayoutItem,
	syncDrunkWinePhotos,
} from "#/lib/services/drunk-wine-service";

// マイセラーのワイン写真アップロード。/api/upload(アバター専用・ユーザ毎1キー固定)
// とはキー体系が異なるため別ルートにする。写真集合を「最終並び順」で全置換で同期する
// (追加・削除・並べ替え・差し替えを1回のPOSTで反映)。
// FormData:
//  - entryId=対象エントリID(本人所有のみ。所有権はサービス層で userId と突合)
//  - photo=File(新規追加ぶん。0個以上。順序は layout の new.index が参照する)
//  - layout=JSON文字列。最終並び順の配列で各要素は
//      { "type": "existing", "key": R2キー } … 既存写真を保持
//      { "type": "new", "index": number }    … photo[index] を新規追加
// R2キーの実体はサービス層が採番するため、クライアントは new を index で指す。

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type LayoutEntry =
	| { type: "existing"; key: string }
	| { type: "new"; index: number };

/** layout JSON をパース・検証する。不正なら null を返す(呼び出し側で400)。 */
function parseLayout(raw: unknown, fileCount: number): LayoutEntry[] | null {
	if (typeof raw !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const out: LayoutEntry[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") return null;
		const rec = item as Record<string, unknown>;
		if (rec.type === "existing") {
			if (typeof rec.key !== "string" || rec.key.length === 0) return null;
			out.push({ type: "existing", key: rec.key });
		} else if (rec.type === "new") {
			if (
				typeof rec.index !== "number" ||
				!Number.isInteger(rec.index) ||
				rec.index < 0 ||
				rec.index >= fileCount
			) {
				return null;
			}
			out.push({ type: "new", index: rec.index });
		} else {
			return null;
		}
	}
	return out;
}

export const Route = createFileRoute("/api/wine-photos")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await auth.api.getSession({
					headers: request.headers,
				});
				if (!session) return jsonError("Unauthorized", 401);

				// formData() はボディ全体をメモリに載せるため、明らかに大きい
				// リクエストはパース前に弾く(全枚数ぶん + multipart境界等のオーバーヘッド)
				const contentLength = Number(
					request.headers.get("content-length") ?? 0,
				);
				if (
					contentLength >
					MAX_PHOTO_BYTES * MAX_PHOTOS_PER_ENTRY + 64 * 1024
				) {
					return jsonError("Files exceed size limit", 413);
				}

				let formData: FormData;
				try {
					formData = await request.formData();
				} catch {
					return jsonError("Invalid form data", 400);
				}

				const entryId = formData.get("entryId");
				if (typeof entryId !== "string" || entryId.length === 0) {
					return jsonError("No entryId provided", 400);
				}

				const files = formData
					.getAll("photo")
					.filter((f): f is File => f instanceof File);
				for (const file of files) {
					if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
						return jsonError("Unsupported image type", 400);
					}
					if (file.size > MAX_PHOTO_BYTES) {
						return jsonError("File exceeds 5 MB limit", 400);
					}
				}

				const layout = parseLayout(formData.get("layout"), files.length);
				if (!layout) {
					return jsonError("Invalid layout", 400);
				}
				if (layout.length > MAX_PHOTOS_PER_ENTRY) {
					return jsonError(`写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです`, 400);
				}

				// layout(index参照)を実バイト列へ解決してサービス層の PhotoLayoutItem に変換
				const items: PhotoLayoutItem[] = [];
				for (const entry of layout) {
					if (entry.type === "existing") {
						items.push({ kind: "existing", key: entry.key });
						continue;
					}
					const file = files[entry.index];
					if (!file) return jsonError("Invalid layout", 400);
					items.push({
						kind: "new",
						bytes: await file.arrayBuffer(),
						mimeType: file.type,
					});
				}

				try {
					const entry = await syncDrunkWinePhotos(
						session.user.id,
						entryId,
						items,
					);
					return new Response(JSON.stringify({ entry }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					return jsonError(message, message === "Entry not found" ? 404 : 400);
				}
			},
		},
	},
});
