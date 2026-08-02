-- マイセラーの粗い産地紐付け(地域・国)。AOPまで特定できないワイン用で、参照先は
-- 静的マスタ(region_id は src/lib/wine/regions.ts、country_id は countries.ts)。
-- aop_id とあわせて「最も細かい1つだけを保存する」排他をサービス層で強制する
-- (aop_id があれば region/country は NULL、region_id があれば country は NULL)。
-- SQLite の ADD COLUMN は IF NOT EXISTS を持たないため 0012/0021 と同じ素の ALTER
-- (再適用は wrangler がファイル名で適用済み管理するため通常起きない)。
ALTER TABLE `drunk_wine` ADD COLUMN `region_id` text;
--> statement-breakpoint
ALTER TABLE `drunk_wine` ADD COLUMN `country_id` text;
