-- Issue #645 expand: drunk_wine.photo_keys / photo_kinds の並列JSON配列を
-- wine_photo 子テーブルへ移す第1段階(expand)。
--
-- 旧2列は「同じ順・同じ長さ」の並列配列で、不変条件を resolveStoredPhotoKinds の
-- 読み取り時正規化でしか守れていなかった。配列丸ごとの read-modify-write になるため
-- 並行更新で写真を失い(#637。つなぎの楽観ロックで止めている)、写真単位の
-- メタデータを足すたびに並列配列が増え、「このR2キーを参照しているエントリ」も
-- SQL で引けない。行単位になれば追加・削除が1行の INSERT / DELETE になり、
-- 楽観ロックは不要になる。
--
-- expand のみ(DROP / RENAME / 既存列の NOT NULL 化は無し)。旧2列は残し、
-- このPRでは書き込みを二重化(旧列 + 子テーブル)して読み取りだけ子テーブルへ
-- 切り替える。旧列の DROP は次PRで `-- allow-destructive-migration` 付きで行う
-- (0040 → 0041 と同じ運び。CLAUDE.md「DBスキーマ変更を含むPR」)。
--
-- 新規テーブル + nullable なしの DEFAULT 付き列だけなので、このテーブルを書かない
-- 旧コードの INSERT もそのまま通る。旧コード×新スキーマの window で旧コードが
-- 書いた写真は旧列にだけ載るため、読み取りは子テーブルが空の行に限り旧列へ
-- フォールバックする(サービス層の resolveEntryPhotos。warn 付き)。
CREATE TABLE IF NOT EXISTS `wine_photo` (
	`id` text PRIMARY KEY NOT NULL,
	`drunk_wine_id` text NOT NULL,
	-- 所有権チェックを JOIN 無しで行うため冗長に持つ(WHERE id AND user_id の規約)
	`user_id` text NOT NULL,
	-- R2キー。サムネイルは原寸キーからの導出(thumbKeyForPhotoKey)なので列を持たない
	`r2_key` text NOT NULL,
	-- 由来。値のSSOTは wine-list-extraction.ts の PhotoKind("bottle" | "web")
	`kind` text DEFAULT 'bottle' NOT NULL,
	-- 表示順(0始まり)。先頭=代表サムネイル(旧 photo_keys の順序と同じ意味)
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`drunk_wine_id`) REFERENCES `drunk_wine`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 同じ写真キーの二重引き継ぎをアプリ側の読み直しではなく制約で弾く(append の INSERT OR IGNORE の
-- 衝突先。読み直しと書き込みの間に並行 append が割り込んでも行が増えない)。
CREATE UNIQUE INDEX IF NOT EXISTS `wine_photo_entry_r2_key_uq` ON `wine_photo` (`drunk_wine_id`,`r2_key`);
--> statement-breakpoint
-- エントリの写真一覧は「この銘柄の写真を position 順」で引くので、その形の複合index
CREATE INDEX IF NOT EXISTS `wine_photo_entry_position_idx` ON `wine_photo` (`drunk_wine_id`,`position`);
--> statement-breakpoint
-- 既存行のバックフィル。photo_keys の各要素を json_each で1行に展開し、同じ添字の
-- photo_kinds が 'web' のときだけ web、他は bottle に正規化する(resolveStoredPhotoKinds
-- と同じ規則。長さ不一致・未知値は bottle に倒れる)。空配列の行は json_each が
-- 0行を返すので何も起きない。INSERT OR IGNORE + 上の unique で再適用しても増えない。
INSERT OR IGNORE INTO `wine_photo` (`id`, `drunk_wine_id`, `user_id`, `r2_key`, `kind`, `position`, `created_at`)
SELECT lower(hex(randomblob(16))), `d`.`id`, `d`.`user_id`, `j`.`value`,
	CASE WHEN json_extract(`d`.`photo_kinds`, '$[' || `j`.`key` || ']') = 'web' THEN 'web' ELSE 'bottle' END,
	CAST(`j`.`key` AS integer), `d`.`created_at`
FROM `drunk_wine` AS `d`, json_each(`d`.`photo_keys`) AS `j`;
