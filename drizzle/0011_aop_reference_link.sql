CREATE TABLE IF NOT EXISTS `aop_reference_link` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`aop_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `aop_reference_link_user_aop_idx` ON `aop_reference_link` (`user_id`,`aop_id`);
