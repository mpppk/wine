-- 旧飲用記録(wine_tasting)・旧目撃記録(wine_sighting)の2テーブルと、
-- drunk_wine の旧集計列(sighting_count / last_seen_on)を削除する
-- (Issue #606 PR3/3, contract)。
--
-- allow-destructive-migration
--
-- 意図的な破壊的変更。#24 の規約どおり2つのデプロイに分けてある:
--   1. #608 (expand)  — wine_encounter を新設し、旧2テーブルから移送した。
--                       以降どこからも旧2テーブルを読み書きしない
--   2. #611 (UI統合)  — UI・server fn も体験記録へ統合し、旧テーブルを参照する
--                       コードが main から完全に消えた。**本番デプロイ済み**
--   3. 本マイグレーション (contract) — 誰も読み書きしなくなった2テーブルと
--      旧集計2列を削除する
--
-- deploy command はビルド成功後・デプロイ直前に db:migrate:remote を流すため、
-- 適用〜新Worker反映までの窓は「新スキーマ×旧コード」で動く。2 を先にデプロイ
-- してあるので、その窓で走る旧コード(=2 のコード)は wine_tasting /
-- wine_sighting / sighting_count / last_seen_on を SELECT しない。
-- MCP の add_wine_tasting はツール名であってテーブル名ではないため DROP とは
-- 無関係で、rename しない(WINE_TASTING_FIELDS 等の互換層も残す)。
--
-- DROP は不可逆のため、本ファイルでは DROP 文の前に 0040 の移送SQL(2つの
-- INSERT OR IGNORE と集計4列の UPDATE)を再掲して実行してから落とす。
-- INSERT OR IGNORE + 決定的id('tasting-' || id / 'sighting-' || id)なので、
-- 既に移送済みの行に対しては no-op で、デプロイ窓で旧テーブルへ書かれた行だけが
-- 追加で拾われる。「取りこぼしがあっても同じマイグレーションの中で必ず回収して
-- から落とす」ことが構造的に保証される。集計 UPDATE の式は 0040 と、実行時の
-- recomputeDrunkWineAggregates(src/lib/services/drunk-wine-service.ts)と同一。
--
-- 冪等性について: DROP TABLE は IF EXISTS を付けて冪等に書ける。一方 SQLite に
-- DROP COLUMN IF EXISTS は無いため、drunk_wine の2文だけは冪等に書けない。
-- 適用済みの管理はファイル名単位なので同一DBへ二重適用されることはないが、
-- 共有プレビューDB(#54)で同番号・別名のマイグレーションと衝突させないよう、
-- スキーマ変更PRは1本ずつマージすること。
--
-- sighting_count / last_seen_on は drunk_wine のインデックス
-- (drunk_wine_user_created_idx)に含まれないため、付随して落とすインデックスは
-- 無い。DROP TABLE は wine_tasting_entry_drank_idx /
-- wine_tasting_user_drank_idx / wine_sighting_entry_seen_idx /
-- wine_sighting_user_seen_idx / wine_sighting_user_place_idx ごと消える。
--
-- 旧2テーブルから移送する(0040 と同一文の再掲。DROP 前の取りこぼし回収)。
-- 移送で行はマージしない(0040 の判断を踏襲)。
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
-- 集計キャッシュを体験記録から再計算する(0040 と同一文の再掲)。
UPDATE `drunk_wine` SET
	`tasting_count` = (SELECT count(*) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id` AND `wine_encounter`.`drank` = 1),
	`last_drank_on` = (SELECT max(`occurred_on`) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id` AND `wine_encounter`.`drank` = 1),
	`encounter_count` = (SELECT count(*) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id`),
	`last_encountered_on` = (SELECT max(`occurred_on`) FROM `wine_encounter` WHERE `wine_encounter`.`drunk_wine_id` = `drunk_wine`.`id`);
--> statement-breakpoint
DROP TABLE IF EXISTS `wine_tasting`;
--> statement-breakpoint
DROP TABLE IF EXISTS `wine_sighting`;
--> statement-breakpoint
ALTER TABLE `drunk_wine` DROP COLUMN `sighting_count`;
--> statement-breakpoint
ALTER TABLE `drunk_wine` DROP COLUMN `last_seen_on`;
