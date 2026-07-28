-- drunk_wine の旧列 drank_on / rating / memo を削除する(Issue #205 の contract 後半)。
--
-- allow-destructive-migration
--
-- 意図的な破壊的変更。#24 の規約どおり2つのデプロイに分けてある:
--   1. #200 (expand)  — 飲んだ日・評価・メモを wine_tasting へ移し、旧列へは
--                       「最新の飲用記録の射影」として二重書きを継続した
--   2. #233 (contract 前半) — 読み取りを last_drank_on と wine_tasting からの
--                       導出へ切り替え、二重書きも外した。**本番デプロイ済み**
--   3. 本マイグレーション (contract 後半) — 誰も読み書きしなくなった3列を削除する
--
-- deploy command はビルド成功後・デプロイ直前に db:migrate:remote を流すため、
-- 適用〜新Worker反映までの窓は「新スキーマ×旧コード」で動く。2 を先にデプロイ
-- してあるので、その窓で走る旧コード(=2 のコード)はこの3列を SELECT しない。
--
-- 冪等性について: SQLite に DROP COLUMN IF EXISTS は無いため、この3文だけは
-- 冪等に書けない。適用済みの管理はファイル名単位なので同一DBへ二重適用される
-- ことはないが、共有プレビューDB(#54)で同番号・別名のマイグレーションと衝突
-- させないよう、スキーマ変更PRは1本ずつマージすること。
--
-- 3列とも drunk_wine のインデックス(drunk_wine_user_created_idx)に含まれないため、
-- 付随して落とすインデックスは無い。
ALTER TABLE `drunk_wine` DROP COLUMN `drank_on`;
--> statement-breakpoint
ALTER TABLE `drunk_wine` DROP COLUMN `rating`;
--> statement-breakpoint
ALTER TABLE `drunk_wine` DROP COLUMN `memo`;
