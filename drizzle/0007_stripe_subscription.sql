ALTER TABLE `user` ADD COLUMN `stripe_customer_id` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`reference_id` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`status` text DEFAULT 'incomplete',
	`period_start` integer,
	`period_end` integer,
	`trial_start` integer,
	`trial_end` integer,
	`cancel_at_period_end` integer DEFAULT false,
	`cancel_at` integer,
	`canceled_at` integer,
	`ended_at` integer,
	`seats` integer,
	`billing_interval` text,
	`stripe_schedule_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subscription_referenceId_idx` ON `subscription` (`reference_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subscription_stripeCustomerId_idx` ON `subscription` (`stripe_customer_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subscription_stripeSubscriptionId_idx` ON `subscription` (`stripe_subscription_id`);
