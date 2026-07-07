CREATE TABLE IF NOT EXISTS `oauth_application` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`metadata` text,
	`client_id` text NOT NULL,
	`client_secret` text,
	`redirect_urls` text NOT NULL,
	`type` text NOT NULL,
	`disabled` integer DEFAULT false,
	`user_id` text REFERENCES `user`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `oauth_application_client_id_unique` ON `oauth_application` (`client_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauthApplication_userId_idx` ON `oauth_application` (`user_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token_expires_at` integer NOT NULL,
	`refresh_token_expires_at` integer NOT NULL,
	`client_id` text NOT NULL REFERENCES `oauth_application`(`client_id`) ON DELETE CASCADE,
	`user_id` text REFERENCES `user`(`id`) ON DELETE CASCADE,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `oauth_access_token_access_token_unique` ON `oauth_access_token` (`access_token`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `oauth_access_token_refresh_token_unique` ON `oauth_access_token` (`refresh_token`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL REFERENCES `oauth_application`(`client_id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`scopes` text NOT NULL,
	`consent_given` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);
