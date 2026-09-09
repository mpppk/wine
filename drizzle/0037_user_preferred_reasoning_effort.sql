-- ワイン分析の推論の深さのユーザ設定(プロフィール画面で変更)。null は既定
-- (low)。許可リストは src/lib/ai/config.ts の REASONING_EFFORT_KEYS
-- (書き込みは better-auth の additionalFields validator で検証)。
-- SQLite の ADD COLUMN は IF NOT EXISTS を持たないため 0012/0021 と同じ素の ALTER
-- (再適用は wrangler がファイル名で適用済み管理するため通常起きない)。
ALTER TABLE `user` ADD COLUMN `preferred_reasoning_effort` text;
