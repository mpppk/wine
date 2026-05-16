-- Better Auth tables for SQLite/D1
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" integer DEFAULT false NOT NULL,
  "image" text,
  "created_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  "updated_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" integer NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  "updated_at" integer NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" text,
  "active_team_id" text
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("user_id");

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" integer,
  "refresh_token_expires_at" integer,
  "scope" text,
  "password" text,
  "created_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  "updated_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("user_id");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  "updated_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");

CREATE TABLE IF NOT EXISTS "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "created_at" integer NOT NULL,
  "metadata" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "organization_slug_uidx" ON "organization"("slug");

CREATE TABLE IF NOT EXISTS "team" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_at" integer NOT NULL,
  "updated_at" integer
);
CREATE INDEX IF NOT EXISTS "team_organizationId_idx" ON "team"("organization_id");

CREATE TABLE IF NOT EXISTS "team_member" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" integer
);
CREATE INDEX IF NOT EXISTS "teamMember_teamId_idx" ON "team_member"("team_id");
CREATE INDEX IF NOT EXISTS "teamMember_userId_idx" ON "team_member"("user_id");

CREATE TABLE IF NOT EXISTS "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text DEFAULT 'member' NOT NULL,
  "created_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON "member"("organization_id");
CREATE INDEX IF NOT EXISTS "member_userId_idx" ON "member"("user_id");

CREATE TABLE IF NOT EXISTS "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "team_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON "invitation"("organization_id");
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation"("email");
