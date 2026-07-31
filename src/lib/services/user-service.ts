import { eq } from "drizzle-orm";
import { db } from "#/db";
import * as authSchema from "#/db/auth-schema";
import { isBanActive } from "#/lib/admin/moderation";
import { NotFoundError } from "#/lib/errors";

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
		})
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId));
	if (!user) throw new NotFoundError("User not found");
	return user;
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
