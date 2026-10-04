-- user の表示ロケール(i18n Phase 1 #536)。null は既定(ja)。
-- 書き込みは better-auth の additionalFields validator で検証(許可リストは
-- src/lib/locale.ts の LOCALES)。プロフィール画面・ヘッダーで変更する。
-- 列は「保存先」であって「解決経路」ではない: 実行時の解決は Cookie
-- (wine_locale)だけを見て、全SSRでD1を引かない。ログイン時と設定変更時に
-- サーバがCookieを書き戻す(src/server/locale.ts)。
-- SQLite の ADD COLUMN は IF NOT EXISTS を持たないため 0021 と同じ素の ALTER
-- (再適用は wrangler がファイル名で適用済み管理するため通常起きない)。
ALTER TABLE `user` ADD COLUMN `locale` text;
