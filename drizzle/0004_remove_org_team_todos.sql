DROP TABLE IF EXISTS `invitation`;
--> statement-breakpoint
DROP TABLE IF EXISTS `team_member`;
--> statement-breakpoint
DROP TABLE IF EXISTS `member`;
--> statement-breakpoint
DROP TABLE IF EXISTS `team`;
--> statement-breakpoint
DROP TABLE IF EXISTS `organization`;
--> statement-breakpoint
DROP TABLE IF EXISTS `todos`;
--> statement-breakpoint
ALTER TABLE `session` DROP COLUMN `active_organization_id`;
--> statement-breakpoint
ALTER TABLE `session` DROP COLUMN `active_team_id`;
