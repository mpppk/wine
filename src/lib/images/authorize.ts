import { auth } from "#/lib/auth";
import {
	EXPIRES_PARAM,
	ownerOfPrivateImageKey,
	SIGNATURE_PARAM,
	verifyImageSignature,
} from "#/lib/images/signed-url";
import { getImageSigningKey } from "#/lib/images/signing-key";
import { logError } from "#/lib/logger";

/**
 * 非公開画像(wines/ = マイセラー写真)の認可。Issue #149。
 *
 * 1. 短命の署名付きURL。MCPホストや埋め込みビュー(サンドボックス iframe)は
 *    不透明オリジンから読むため Cookie が乗らない。有効期限とキーをHMACで
 *    束ねた署名で、露出範囲と有効期間を限定する。
 * 2. 本人のセッション。Webアプリ内の <img> は same-origin なので Cookie が乗る。
 *    キーに含まれる userId とセッションの userId が一致する場合のみ許可する。
 *
 * どちらも満たさなければ false。配信側は 403 ではなく 404 を返す
 * (存在の有無を漏らさないため)。
 *
 * 配信ルートから切り出しているのは、workers プール上のテストから直接駆動して
 * 「署名が無ければ他人の写真を読めない」ことを回帰固定するため。
 */
export async function isAuthorizedForPrivateImage(
	request: Request,
	url: URL,
	r2Key: string,
): Promise<boolean> {
	const exp = url.searchParams.get(EXPIRES_PARAM);
	const sig = url.searchParams.get(SIGNATURE_PARAM);
	if (exp && sig) {
		try {
			const key = await getImageSigningKey();
			if (await verifyImageSignature(key, r2Key, exp, sig, Date.now())) {
				return true;
			}
		} catch (e) {
			// 鍵が取得できない場合は署名経路を諦め、セッション認可だけで判定する
			// (fail-closed。ここで true を返さない)。
			// 例外は必ず `err` フィールドで渡す(logger 側が文字列化する)。他の全経路と
			// 揃えないと、Workers Logs で err を軸に横断検索したときにここだけ漏れる(#271)。
			// 対象キーも載せる: R2 障害で非公開写真だけ404になる事象と結び付けられるようにする。
			logError("failed to load image signing key", { err: e, r2Key });
		}
	}

	const owner = ownerOfPrivateImageKey(r2Key);
	if (!owner) return false;
	const session = await auth.api.getSession({ headers: request.headers });
	return session?.user.id === owner;
}
