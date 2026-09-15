-- 飲用記録(wine_tasting)と目撃記録(wine_sighting)を体験記録(wine_encounter)
-- 1テーブルへ統合する(Issue #606 PR1/3, expand)。
--
-- 「飲んだということは必ずそのワインに出会ったということでもある」ため、分けるべきは
-- 種類ではなく属性という整理。「そのワインに出会った1回」が1行で、飲んだかどうかは
-- その回の属性(drank フラグ)になる。レストランで飲んだ回の場所・価格・写真が
-- 飲用記録にも付くようになり、「この店で飲んだワイン」が場所フィルタに拾われる。
--
-- 所有状態(status) ⊥ 飲用履歴の直交2軸(#195)は変えない。#358 が第3の軸として足した
-- 目撃記録を、第2の軸へ畳み戻す形になる。
--
-- expand のみ(DROP / RENAME / 既存列の NOT NULL 化は無し)。旧2テーブルは残し、
-- 以降どこからも読み書きしない。DROP は次PR(0041)で `-- allow-destructive-migration`
-- 付きで行う。`drunk_wine` の旧集計列(sighting_count / last_seen_on)も同様に残す。
--
-- 新規列 + 定数 DEFAULT / nullable の追加だけなので、この列を書かない旧コードの
-- INSERT もそのまま通る(0018 で status を足したのと同じ形)。
CREATE TABLE IF NOT EXISTS `wine_encounter` (
	`id` text PRIMARY KEY NOT NULL,
	`drunk_wine_id` text NOT NULL,
	-- 所有権チェックを JOIN 無しで行うため冗長に持つ(WHERE id AND user_id の規約)
	`user_id` text NOT NULL,
	-- 旧 wine_sighting.place_id。飲んだ回にも付く(これが「2回入力」の主因の解消)
	`place_id` text,
	`batch_id` text,
	-- import_batch.photo_keys の添字(0始まり)。どの写真に写っていたか
	`photo_index` integer,
	-- そのワインが写っていたバッチ写真の番号の一覧(#574)。`photo_index`(先頭1枚の
	-- 後方互換)と併存する。NULL = 先頭1枚だけの従来行(読み取りは `photo_index` へ退避)
	`photo_indexes` text,
	-- 旧 drank_on / seen_on の統合。"YYYY-MM-DD"。覚えていない場合は NULL(従来どおり)
	`occurred_on` text,
	-- この回に飲んだか。drizzle は integer({ mode: "boolean" }) で 0/1 として読む
	`drank` integer DEFAULT 0 NOT NULL,
	-- 1–5。drank=1 のときだけ意味を持つ
	`rating` integer,
	-- その場での値段(円)。銘柄側の drunk_wine.price とは別物
	`price` integer,
	-- 旧2テーブルの memo を1本に統合(感想と状況で欄を分けないのが本 Issue の判断)
	`memo` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`drunk_wine_id`) REFERENCES `drunk_wine`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	-- 場所・バッチを消しても「出会った」事実は残す
	FOREIGN KEY (`place_id`) REFERENCES `place`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- 銘柄ごとの一覧・飲用の最新1件の導出・集計。旧 wine_tasting_entry_drank_idx の
-- 役割を drank 込みで引き継ぐ
CREATE INDEX IF NOT EXISTS `wine_encounter_entry_idx` ON `wine_encounter` (`drunk_wine_id`,`drank`,`occurred_on`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wine_encounter_user_occurred_idx` ON `wine_encounter` (`user_id`,`occurred_on`);
--> statement-breakpoint
-- 「この場所での体験一覧」用。所有権の user_id を先頭に置く
CREATE INDEX IF NOT EXISTS `wine_encounter_user_place_idx` ON `wine_encounter` (`user_id`,`place_id`);
--> statement-breakpoint
-- 集計キャッシュの置き換え。tasting_count / last_drank_on は意味不変で残し、
-- sighting_count / last_seen_on は encounter_count / last_encountered_on へ置き換える。
-- 「飲んだ = 必ず出会った」を採るので、後者2列は飲んだ回も数える。新規列 + 定数
-- DEFAULT / nullable は SQLite が既存行を埋めるので、既存列の NOT NULL 化のような
-- 破壊的変更ではない(0022 で sighting_count を足したのと同じ形)。
ALTER TABLE `drunk_wine` ADD COLUMN `encounter_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `drunk_wine` ADD COLUMN `last_encountered_on` text;
--> statement-breakpoint
-- 旧2テーブルから移送する。id は決定的派生 + INSERT OR IGNORE で、再適用が no-op に
-- なり共有プレビューDB(#54)へ冪等に打てる(0018 の 'legacy-' || id と同じ流儀)。
--
-- 移送で行はマージしない。「同じ銘柄・同じ日の飲用 + 目撃」を機械的に1行へ畳むと、
-- 利用者が別の出来事として記録したものを潰しうるため。統合後の UI から手で不要な行を
-- 消せる(例外の batch 由来ペアも既定はマージしない。Issue #606 の決定どおり)。
INSERT OR IGNORE INTO `wine_encounter`
	(`id`, `drunk_wine_id`, `user_id`, `place_id`, `batch_id`, `photo_index`, `photo_indexes`, `occurred_on`, `drank`, `rating`, `price`, `memo`, `created_at`, `updated_at`)
SELECT
	'tasting-' || `id`, `drunk_wine_id`, `user_id`, NULL, `batch_id`, NULL, NULL, `drank_on`, 1, `rating`, NULL, `memo`, `created_at`, `updated_at`
FROM `wine_tasting`;
--> statement-breakpoint
INSERT OR IGNORE INTO `wine_encounter`
	(`id`, `drunk_wine_id`, `user_id`, `place_id`, `batch_id`, `photo_index`, `photo_indexes`, `occurred_on`, `drank`, `rating`, `price`, `memo`, `created_at`, `updated_at`)
SELECT
	'sighting-' || `id`, `drunk_wine_id`, `user_id`, `place_id`, `batch_id`, `photo_index`, `photo_indexes`, `seen_on`, 0, NULL, `price`, `memo`, `created_at`, `updated_at`
FROM `wine_sighting`;
--> statement-breakpoint
-- 集計キャッシュを体験記録から再計算する。式は実行時の
-- recomputeDrunkWineAggregates(src/lib/services/drunk-wine-service.ts)と同一で、
-- 整合が崩れたときはこの UPDATE をそのまま打ち直せば復旧できる。
--
-- デプロイ窓(新スキーマ×旧コード)で旧テーブルへ書かれた記録は移送に乗らないため、
-- PR1 のデプロイ完了後にこの移送 SQL(2つの INSERT とこの UPDATE)を手で再実行する。
-- INSERT OR IGNORE + 決定的 id なので冪等で、窓で書かれた行だけが追加で拾われる。
UPDATE `drunk_wine` SET
	`tasting_count` = (SELECT count(*) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id` AND `wine_encounter`.`drank` = 1),
	`last_drank_on` = (SELECT max(`occurred_on`) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id` AND `wine_encounter`.`drank` = 1),
	`encounter_count` = (SELECT count(*) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id`),
	`last_encountered_on` = (SELECT max(`occurred_on`) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id`);
