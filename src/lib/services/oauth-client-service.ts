import { eq } from "drizzle-orm";
import { db } from "#/db";
import { oauthApplication } from "#/db/auth-schema";

// 同意画面(/oauth/consent)に出すクライアント情報の取得(#399)。
//
// **ここで返す値はすべて攻撃者が自由に決められる**。MCP エコシステム互換のため
// 動的クライアント登録(RFC 7591)を無認証で開放しており、誰でも任意の
// `client_name` と `redirect_uris` でクライアントを登録できる。したがって
// 表示側は「登録された申告値」として扱い、検証済みであるかのように見せてはならない
// (同意フィッシング対策の要点は、利用者が"どこへ送られるか"を判断できること)。
//
// クライアントシークレットと metadata は**返さない**。同意の判断に不要で、
// 画面に出す必要が無いものを境界の外へ出さない。

/** 同意画面へ渡す、公開してよいクライアント情報。 */
export interface OAuthClientSummary {
	/** 登録時の client_name(申告値)。未設定なら null。 */
	name: string | null;
	/**
	 * 認可コードの送り先ホスト(重複排除済み)。**利用者が最終的に判断できる唯一の手掛かり**
	 * なので、URL 全体ではなくホストを出す(長いURLはパスに紛れて誤読を誘う)。
	 */
	redirectHosts: string[];
	/** 登録日時(ミリ秒)。「たった今登録されたクライアント」は警戒の材料になる。 */
	registeredAt: number;
}

/** 保存形式(カンマ区切り)からホスト名だけを取り出す。パースできないものは捨てる。 */
function redirectHostsOf(redirectUrls: string): string[] {
	const hosts = redirectUrls
		.split(",")
		.map((raw) => raw.trim())
		.filter(Boolean)
		.map((raw) => {
			try {
				return new URL(raw).host;
			} catch {
				// ネイティブアプリのカスタムスキーム等、URL として解釈できない値。
				// 生の文字列をそのまま出すと表示を汚されるので落とす。
				return null;
			}
		})
		.filter((host): host is string => host !== null);
	return [...new Set(hosts)];
}

/**
 * client_id から同意画面用の情報を引く。未登録・無効化済みは null
 * (呼び出し側は「詳細を出せない」として、より強い警告に倒す)。
 */
export async function getOAuthClientSummary(
	clientId: string,
): Promise<OAuthClientSummary | null> {
	const [row] = await db
		.select({
			name: oauthApplication.name,
			redirectUrls: oauthApplication.redirectUrls,
			disabled: oauthApplication.disabled,
			createdAt: oauthApplication.createdAt,
		})
		.from(oauthApplication)
		.where(eq(oauthApplication.clientId, clientId))
		.limit(1);
	if (!row || row.disabled) return null;
	return {
		name: row.name?.trim() ? row.name.trim() : null,
		redirectHosts: redirectHostsOf(row.redirectUrls),
		registeredAt: row.createdAt.getTime(),
	};
}
