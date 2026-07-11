CREATE TABLE IF NOT EXISTS `coupon_redemption` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`extended_days` integer NOT NULL,
	`redeemed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `coupon_redemption_user_code_uq` ON `coupon_redemption` (`user_id`,`code`);
