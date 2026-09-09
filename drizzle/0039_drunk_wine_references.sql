-- 解析の参考サイト・市場価格を銘柄に保存する。
--
-- これまで参考サイト・価格(IMPL-3)は解析結果の表示専用で、登録すると消えていた。
-- Webで裏を取った $20 のような情報が残らないため、銘柄に属する参考情報として
-- JSON 配列で永続化する列を足す(上限各3件・形の検証は zod + 正規化が関門)。
--
-- NULL 許容で足すだけなので、この列を書かない旧コードの INSERT もそのまま通る
-- (expand-and-contract の対象ではない)。既存行は NULL = 「取得していない」で、
-- 読み取りは空配列へ退避する。パース失敗・範囲外の値は読み取り側で落とす。
ALTER TABLE `drunk_wine` ADD COLUMN `reference_links` text;
ALTER TABLE `drunk_wine` ADD COLUMN `market_prices` text;
