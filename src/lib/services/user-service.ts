import { eq } from "drizzle-orm";
import { db } from "#/db";
import * as authSchema from "#/db/auth-schema";
import { isBanActive } from "#/lib/admin/moderation";
import { NotFoundError } from "#/lib/errors";
import { type LocaleKey, toLocaleKey } from "#/lib/locale";

// User account lookups shared by server functions and MCP tools. Like the rest
// of services/, this takes the acting userId explicitly.

export async function getCurrentUser(userId: string) {
	const [user] = await db
		.select({
			id: authSchema.user.id,
			name: authSchema.user.name,
			email: authSchema.user.email,
			image: authSchema.user.image,
			preferredAiModel: authSchema.user.preferredAiModel,
			preferredLabelEngine: authSchema.user.preferredLabelEngine,
			preferredReasoningEffort: authSchema.user.preferredReasoningEffort,
		})
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId));
	if (!user) throw new NotFoundError("User not found");
	return user;
}

/**
 * ユーザの表示ロケール(i18n Phase 1 #536)。ログイン時にサーバが Cookie
 * (wine_locale)へ書き戻すための読み取り専用の入口。
 *
 * **実行時の解決には使わない**。SSR・server function の解決は Cookie だけを
 * 見る(paraglide の cookie strategy)。ここを全リクエストで引くと D1 クエリが
 * 1本増えるため、呼ぶのはログイン時・設定変更時の同期だけにする。
 *
 * 保存値が不正・未設定なら null(呼び出し側が既定 ja へ倒す)。
 */
export async function getUserLocale(userId: string): Promise<LocaleKey | null> {
	const [row] = await db
		.select({ locale: authSchema.user.locale })
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId));
	if (!row) throw new NotFoundError("User not found");
	return toLocaleKey(row.locale);
}

/**
 * ユーザが現在 BAN されているか(#330)。MCP(`/api/mcp`)の入口ガード用。
 *
 * Web 経路の BAN は better-auth がセッション削除とサインイン拒否で担うが、MCP は
 * OAuth アクセストークンの存在と期限しか見ないため、この関数で明示的に確認する。
 * 行が存在しない(削除済みユーザのトークン)場合も拒否側に倒す。
 */
export async function isUserBanned(userId: string): Promise<boolean> {
	const [row] = await db
		.select({
			banned: authSchema.user.banned,
			banExpires: authSchema.user.banExpires,
		})
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId));
	if (!row) return true;
	return isBanActive(row);
}
