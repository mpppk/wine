CREATE TABLE IF NOT EXISTS `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`target_user_id` text,
	`action` text NOT NULL,
	`detail` text,
	`reason` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `admin_audit_log_target_created_idx` ON `admin_audit_log` (`target_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `admin_audit_log_actor_created_idx` ON `admin_audit_log` (`actor_user_id`,`created_at`);
