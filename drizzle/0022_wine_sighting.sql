-- allow-destructive-migration
--
-- ↑ の理由: 唯一の該当箇所は末尾の
-- `ADD COLUMN sighting_count integer DEFAULT 0 NOT NULL` で、これは
-- **新規列 + 定数 DEFAULT** なので expand-and-contract の対象ではない。
--   - 既存行: SQLite が DEFAULT で埋める(既存列を NOT NULL 化するのとは別物)
--   - デプロイ窓(新スキーマ×旧コード)の旧 INSERT: 列を省いても DEFAULT が入るので落ちない
-- そもそも SQLite は DEFAULT の無い `ADD COLUMN ... NOT NULL` を実行時に拒否するため、
-- 適用可能な形は必ずこの安全な形になる。0018 が status を足したときと同じ形。
--
-- 写真からのワイン一括登録に向けて、「目撃記録」を第3の 1:N 軸として足す(Issue #358)。
--
-- 所有状態(drunk_wine.status) ⊥ 飲用履歴(wine_tasting) の直交2軸(#195)に、
-- 「どこで見かけたか」(wine_sighting)を加える。同じワインを複数の店で見かけたら
-- 1エントリ + 目撃記録 × N になり、一括登録の distinct(重複統合)要件の受け皿になる。
--
-- expand のみ(DROP / RENAME / 既存列の NOT NULL 化は無し)。既存行の目撃記録は
-- 0件が正しいのでデータ移送も要らない。
--
-- 写真のR2キーは `wines/{userId}/{batchId}/{photoId}.{ext}` とし、エントリ写真と
-- 同じ接頭辞に載せる。非公開画像の認可・署名URL・退会時の一括削除がこのレイアウトを
-- 前提に書かれており、専用接頭辞の新設は4箇所の同時拡張を要求するため
-- (詳細は src/db/schema.ts の import_batch の JSDoc)。
CREATE TABLE IF NOT EXISTS `place` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	-- 区分。値のSSOTは src/lib/place/place.ts(DEFAULT_PLACE_KIND とこの DEFAULT を揃える)
	`kind` text DEFAULT 'other' NOT NULL,
	`memo` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 名前の unique 制約は意図的に張らない。同名の別店舗が実在し、表記ゆれの抑制は
-- UI のサジェストで行う(制約で弾くと記録の敷居が上がる)。
CREATE INDEX IF NOT EXISTS `place_user_name_idx` ON `place` (`user_id`,`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `import_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`place_id` text,
	-- 見かけた日 "YYYY-MM-DD"。バッチ内の目撃記録の既定値になる
	`seen_on` text,
	-- R2キーの配列。撮影順で、wine_sighting.photo_index がこの配列の添字
	`photo_keys` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `place`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_batch_user_created_idx` ON `import_batch` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wine_sighting` (
	`id` text PRIMARY KEY NOT NULL,
	`drunk_wine_id` text NOT NULL,
	-- 所有権チェックを JOIN 無しで行うため冗長に持つ(WHERE id AND user_id の規約)
	`user_id` text NOT NULL,
	`place_id` text,
	`batch_id` text,
	-- import_batch.photo_keys の添字(0始まり)。どの写真に写っていたか
	`photo_index` integer,
	-- 見かけた日 "YYYY-MM-DD"。日付を覚えていない記録は NULL
	`seen_on` text,
	-- その店での売値(円)。銘柄側の drunk_wine.price とは別物
	`price` integer,
	`memo` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`drunk_wine_id`) REFERENCES `drunk_wine`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	-- 場所・バッチを消しても「見かけた」事実は残す
	FOREIGN KEY (`place_id`) REFERENCES `place`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wine_sighting_entry_seen_idx` ON `wine_sighting` (`drunk_wine_id`,`seen_on`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wine_sighting_user_seen_idx` ON `wine_sighting` (`user_id`,`seen_on`);
--> statement-breakpoint
-- 「この店で見かけたワイン一覧」用。所有権の user_id を先頭に置く
CREATE INDEX IF NOT EXISTS `wine_sighting_user_place_idx` ON `wine_sighting` (`user_id`,`place_id`);
--> statement-breakpoint
-- 一覧・地図・ダッシュボードが全て drunk_wine の単表クエリのため、目撃記録の集計も
-- tasting_count / last_drank_on と同じくここに非正規化する(JOIN/N+1 を持ち込まない)。
-- 新規列 + 定数 DEFAULT は SQLite が既存行を埋めるので、既存列の NOT NULL 化のような
-- 破壊的変更ではない(0018 で status を足したのと同じ形)。
ALTER TABLE `drunk_wine` ADD COLUMN `last_seen_on` text;
--> statement-breakpoint
ALTER TABLE `drunk_wine` ADD COLUMN `sighting_count` integer DEFAULT 0 NOT NULL;
