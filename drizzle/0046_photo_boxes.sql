-- Issue #693: 写真からの一括登録で、その銘柄が写真のどこにあったかを枠で示す。
--
-- 複数の銘柄が写った写真(ワインリスト・棚)から登録すると、単体写真も web 画像も
-- 無い銘柄には全体写真がそのまま複製され、どの銘柄も同じ写真になっていた。
-- 解析ジョブが Jev の Box で求めた枠を、**写真は焼き込まずに座標だけ**保存し、
-- 表示時に重ねる(値の形・正規化は src/lib/drunk-wine/photo-box.ts が SSOT)。
--
--  - wine_encounter.photo_boxes: 体験記録が参照するバッチ写真ごとの枠。
--    `[{ "photoIndex": n, "box": { "top", "bottom", "left", "right" } }]`(0〜1 の比率)。
--    登録時にレビュー画面で手直しされた値が入り、銘柄写真の複製
--    (adoptBatchPhotosForWines)はここから枠を写す。体験記録のバッチ写真の表示にも使う
--  - wine_photo.box: 銘柄の写真1枚に重ねる枠 `{ "top", "bottom", "left", "right" }`
--
-- どちらも NULL 許容で足すだけなので、この列を書かない旧コードの INSERT もそのまま通る
-- (expand-and-contract の対象ではない)。既存行は NULL =「枠なし」で、読み取りは
-- 壊れた値も枠なしへ退避する。
ALTER TABLE `wine_encounter` ADD COLUMN `photo_boxes` text;
--> statement-breakpoint
ALTER TABLE `wine_photo` ADD COLUMN `box` text;
