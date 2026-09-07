-- ユーザがプロフィールで選んだUIロケールを保存する(#536)。
-- NULL は未設定を表し、匿名アクセス時の Cookie 解決をそのまま優先する。
-- SQLite の ADD COLUMN には IF NOT EXISTS がないため、連番を重複適用しない。
ALTER TABLE `user` ADD COLUMN `locale` text;
