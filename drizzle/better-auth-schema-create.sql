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
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
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
