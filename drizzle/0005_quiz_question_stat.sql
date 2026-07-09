CREATE TABLE IF NOT EXISTS `quiz_question_stat` (
	`user_id` text NOT NULL,
	`question_key` text NOT NULL,
	`quiz_type` text NOT NULL,
	`region_id` text NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`incorrect_count` integer DEFAULT 0 NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`last_answered_at` integer NOT NULL,
	`last_correct_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `question_key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
