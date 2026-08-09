-- Issue #498: 解析ジョブに「その写真をどこで・いつ撮ったか」を持たせる。
--
-- 写真ウィザードは解析を投げる前に「写真の場所」と「撮影日」を受け取るが、その入力は
-- ジョブに一切残っていなかった。完了を待たずに離脱し、マイセラーのバッジから
-- 受け取った回(`/cellar/new?labelJob=<id>`)は、投入時に入力した場所・見かけた日が
-- 復元できず空のフォームが開く。#496 で直したのは「画面に留まったまま切り替えた回」
-- だけで、そちらは荷物をクライアントの state で運べていたに過ぎない。
--
-- **`place_id` と `new_place_name` の2列に分ける**。ウィザードは既存の場所の選択と
-- 「その場で新しい場所を作る」の両方を受け付けるが、後者はまだ place 行が無い
-- (一括登録は確定時に作る)。投入の時点で place を作ってしまうと、記録せずに離脱した
-- 回のぶんだけ空の場所がマスタに増える。名前のまま持ち回り、記録の確定時に作る。
--
-- 3列とも nullable + デフォルト無しの追加なので expand-and-contract の対象ではない
-- (0031/0033 と同じ形)。既存行は NULL = 「場所も日付も分からない投入」で、
-- 従来どおり空のフォームが開くだけ。旧コードはこの列を書かないので、
-- 「新スキーマ×旧コード」の窓でも動く。
--
-- place_id は ON DELETE set null。場所を消してもジョブと解析結果は残す
-- (受け取りは「場所の指定なし」に落ちるだけで、候補は捨てずに済む)。
--
-- 索引は張らない。参照は常に「ジョブIDで1行引いてから見る」向きで、place_id や
-- seen_on からジョブを逆引きする経路が無い。
ALTER TABLE `label_analysis_job` ADD COLUMN `place_id` text REFERENCES `place`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `label_analysis_job` ADD COLUMN `new_place_name` text;--> statement-breakpoint
ALTER TABLE `label_analysis_job` ADD COLUMN `seen_on` text;
