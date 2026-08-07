-- Issue #466: エチケット解析の完了を Web Push で通知するための購読の保存先。
--
-- いまの完了通知はマイセラーを開いたときのバッジだけ(#463)で、「投げてアプリを閉じた」
-- 場合は次に開くまで気づけない。解析は17〜31秒(#463 の本番実測)なので、実際には
-- 「閉じている間に終わっている」のが普通。
--
-- 1ユーザが複数の購読を持つ(PC・スマホ・ブラウザごとに別の購読になる)ので 1:N。
-- **endpoint が購読の同一性**で、同じブラウザで再購読すると同じ endpoint が返るため
-- ここに unique を張って upsert の衝突先にする(重複して同じ端末へ2通送らない)。
--
-- expand のみ(新規テーブル1つ)。旧コードはこの表を知らないので「新スキーマ×旧コード」の
-- 窓でも問題にならない。
--
-- **鍵の中身は購読ごとの公開情報**(p256dh はブラウザが生成する公開鍵、auth は共有秘密)。
-- どちらもその購読へ送るためだけに使う値で、他の購読やユーザには流用できない。とはいえ
-- 漏れれば当該端末へ通知を送れてしまうので、他のユーザデータと同じくアプリ経由でしか
-- 読めない場所(D1)に置く。
CREATE TABLE IF NOT EXISTS `push_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	-- プッシュサービスのURL。購読の同一性はこれで決まる
	`endpoint` text NOT NULL,
	-- RFC 8291 の鍵。ブラウザの PushSubscription.getKey() から取る
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	-- 購読した端末の目安(User-Agent の抜粋)。複数端末を見分けるためだけの表示用
	`user_agent` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	-- 最後に送信が成功した時刻。無効化の調査用(送れていない購読の棚卸し)
	`last_notified_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 同じ端末の再購読は同じ endpoint で来る。upsert の衝突先
CREATE UNIQUE INDEX IF NOT EXISTS `push_subscription_endpoint_uq` ON `push_subscription` (`endpoint`);
--> statement-breakpoint
-- 「このユーザの購読を全部」= 通知送信時の唯一のクエリ
CREATE INDEX IF NOT EXISTS `push_subscription_user_idx` ON `push_subscription` (`user_id`);
