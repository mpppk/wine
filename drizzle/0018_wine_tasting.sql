-- マイセラーに「所有状態」と「飲用記録」を導入する(Issue #195)。
-- 所有状態(drunk_wine.status)と飲用履歴(wine_tasting)は直交する2軸で持つ。
-- 「以前飲んだワインをもう一度購入した」= status='owned' かつ 飲用記録あり。
--
-- expand のみ(DROP なし)。旧列 drank_on/rating/memo は残し、「最新の飲用記録の
-- 射影」として書き込みを継続する(読み取り側を触らずに済ませるため)。DROP は次PR。
CREATE TABLE IF NOT EXISTS `wine_tasting` (
	`id` text PRIMARY KEY NOT NULL,
	`drunk_wine_id` text NOT NULL,
	-- 所有権チェックを JOIN 無しで行うため冗長に持つ(WHERE id AND user_id の規約)
	`user_id` text NOT NULL,
	-- 飲んだ日 "YYYY-MM-DD"。日付を覚えていない記録は NULL
	`drank_on` text,
	`rating` integer,
	`memo` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`drunk_wine_id`) REFERENCES `drunk_wine`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wine_tasting_entry_drank_idx` ON `wine_tasting` (`drunk_wine_id`,`drank_on`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wine_tasting_user_drank_idx` ON `wine_tasting` (`user_id`,`drank_on`);
--> statement-breakpoint
-- 既存行はすべて「飲んだワイン」の記録なので finished(手元にない)が現実に最も近い。
-- 新規列への NOT NULL + 定数 DEFAULT は SQLite が既存行を埋めるため、既存列の
-- NOT NULL 化(破壊的)とは別物。
ALTER TABLE `drunk_wine` ADD COLUMN `status` text DEFAULT 'finished' NOT NULL;
--> statement-breakpoint
-- 一覧・地図・ダッシュボードが全て drunk_wine の単表クエリのため、飲用記録の集計を
-- ここに非正規化する(JOIN/N+1 を持ち込まない)。
ALTER TABLE `drunk_wine` ADD COLUMN `last_drank_on` text;
--> statement-breakpoint
ALTER TABLE `drunk_wine` ADD COLUMN `tasting_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 既存の全行を飲用記録1件へ移送する。飲んだ日が未入力の行も必ず作る:
-- 取りこぼすと tasting_count=0 になり、ダッシュボードの本数と「飲んだことがある」
-- フィルタから既存データが丸ごと消える。
--
-- id は drunk_wine.id からの決定的派生。OR IGNORE と合わせて再適用が no-op になり、
-- 共有プレビューDB(#54)へ冪等に打てる。crypto.randomUUID() 規約の意図的な例外
-- (飲用記録の id は URL に載らず、推測不能性が要件ではないため)。
INSERT OR IGNORE INTO `wine_tasting`
	(`id`, `drunk_wine_id`, `user_id`, `drank_on`, `rating`, `memo`, `created_at`, `updated_at`)
SELECT
	'legacy-' || `id`, `id`, `user_id`, `drank_on`, `rating`, `memo`, `created_at`, `updated_at`
FROM `drunk_wine`;
--> statement-breakpoint
-- 集計キャッシュを飲用記録から再計算する。式は実行時の
-- recomputeDrunkWineAggregates(src/lib/services/drunk-wine-service.ts)と同一で、
-- 整合が崩れたときはこの UPDATE をそのまま打ち直せば復旧できる。
UPDATE `drunk_wine` SET
	`tasting_count` = (SELECT count(*) FROM `wine_tasting` WHERE `wine_tasting`.`drunk_wine_id` = `drunk_wine`.`id`),
	`last_drank_on` = (SELECT max(`drank_on`) FROM `wine_tasting` WHERE `wine_tasting`.`drunk_wine_id` = `drunk_wine`.`id`);
