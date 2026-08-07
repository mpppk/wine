-- Issue #460: エチケット解析をジョブ化する(投げたらページを離れてよく、後から完了が分かる)。
--
-- エージェントループ(#458/#459)は写真の拡大・再検索を挟むため1リクエストで完結させるには
-- 長く(実測30秒前後)、加えて「投入したらページを離れたい」という要求がある。後者が決定的で、
-- **クライアントが状態を持つ方式を完全に排除する**——ページを閉じた時点でループを進める主体が
-- 消えるため、サーバが写真(R2)・状態(この表)・進行のすべてを持つ以外に選択肢がない。
--
-- expand のみ(DROP / RENAME / 既存列の NOT NULL 化は無し)。新規テーブル1つだけなので
-- expand-and-contract の対象ではなく、「新スキーマ×旧コード」の窓でも旧コードはこの表を
-- 知らないまま動く。
--
-- 索引の意図:
--  - request_id は予約の冪等キーと1対1。二重投入で同じ予約に2つのジョブがぶら下がらない
--  - (user_id, status) は同時実行上限のカウントと stale 走査(未終端ジョブの列挙)
--  - (user_id, created_at) は「最近のジョブ一覧」(マイセラーの解析中バッジ)
--
-- 画像そのものは D1 に入れず、R2キーだけを持つ。キーは `wines/{userId}/{jobId}/{photoId}.{ext}`
-- とし、マイセラー写真と同じ接頭辞に載せる。非公開画像の認可・署名URL・退会時の一括削除が
-- このレイアウトを前提に書かれており、専用接頭辞の新設は4箇所の同時拡張を要求するため
-- (import_batch の写真キーと同じ判断。0022 の JSDoc 参照)。
CREATE TABLE IF NOT EXISTS `label_analysis_job` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	-- 状態。値のSSOTは src/lib/ai/label-job.ts の LABEL_JOB_STATUSES
	-- (queued → running → succeeded | failed の一方向のみ)
	`status` text DEFAULT 'queued' NOT NULL,
	-- R2キーの配列(撮影順)。終端に到達した時点で削除するので、その後は空配列
	`photo_keys` text DEFAULT '[]' NOT NULL,
	-- 申告枚数。photo_keys は完了後に空になるため、実行記録と見積の再計算にはこちらを使う
	`photo_count` integer NOT NULL,
	-- クレジット台帳の request_id(予約の冪等キー)。settle/refund はここから導出される
	`request_id` text NOT NULL,
	`reserved_credits` integer NOT NULL,
	`reserved_micro_usd` integer NOT NULL,
	-- ユーザがプロフィールで選んでいたエンジン(実行記録の selected)
	`selected_engine` text NOT NULL,
	-- 予約時に解決した実行経路。コンシューマは再解決せずこれを使う(予約と食い違わせない)
	`route` text NOT NULL,
	`suggestions` text,
	`actual_tokens` integer,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `label_analysis_job_request_id_uq` ON `label_analysis_job` (`request_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `label_analysis_job_user_status_idx` ON `label_analysis_job` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `label_analysis_job_user_created_idx` ON `label_analysis_job` (`user_id`,`created_at`);
