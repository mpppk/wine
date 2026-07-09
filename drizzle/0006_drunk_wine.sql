CREATE TABLE IF NOT EXISTS `drunk_wine` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`drank_on` text,
	`aop_id` text,
	`rating` integer,
	`memo` text,
	`vintage` integer,
	`grape_variety_ids` text DEFAULT '[]' NOT NULL,
	`producer` text,
	`price` integer,
	`photo_key` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drunk_wine_user_created_idx` ON `drunk_wine` (`user_id`,`created_at`);
