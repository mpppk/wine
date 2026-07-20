ALTER TABLE `user` ADD COLUMN `role` text;
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `banned` integer;
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `ban_reason` text;
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `ban_expires` integer;
--> statement-breakpoint
ALTER TABLE `session` ADD COLUMN `impersonated_by` text;
