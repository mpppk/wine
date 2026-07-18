-- マイセラーの写真を複数枚対応にする。単一列 photo_key を JSON配列 photo_keys に置換。
-- 既存の photo_key は配列へ退避する(旧R2オブジェクトは移動不要。フラット形式の
-- 旧キーがそのまま配列に入り、/api/images/$ は splat なので引き続き配信できる)。
ALTER TABLE `drunk_wine` ADD COLUMN `photo_keys` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
UPDATE `drunk_wine` SET `photo_keys` = json_array(`photo_key`) WHERE `photo_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `drunk_wine` DROP COLUMN `photo_key`;
