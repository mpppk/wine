-- エチケット解析エンジンのユーザ設定(プロフィール画面で変更)。null は既定
-- (高精度が使える環境なら高精度)。許可リストは src/lib/ai/config.ts の
-- LABEL_ENGINE_KEYS(書き込みは better-auth の additionalFields validator で検証)。
-- SQLite の ADD COLUMN は IF NOT EXISTS を持たないため 0012 と同じ素の ALTER
-- (再適用は wrangler がファイル名で適用済み管理するため通常起きない)。
ALTER TABLE `user` ADD COLUMN `preferred_label_engine` text;
