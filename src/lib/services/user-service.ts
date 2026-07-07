import { eq } from "drizzle-orm";
import { db } from "#/db";
import * as authSchema from "#/db/auth-schema";

// User account lookups shared by server functions and MCP tools. Like the rest
// of services/, this takes the acting userId explicitly.

export async function getCurrentUser(userId: string) {
	const [user] = await db
		.select({
			id: authSchema.user.id,
			name: authSchema.user.name,
			email: authSchema.user.email,
			image: authSchema.user.image,
		})
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId));
	if (!user) throw new Error("User not found");
	return user;
}
