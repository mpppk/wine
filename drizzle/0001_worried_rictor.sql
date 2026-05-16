ALTER TABLE `todos` ADD `description` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `done` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `assignee_id` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `team_id` text NOT NULL;