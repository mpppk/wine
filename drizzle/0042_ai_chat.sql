-- 地域Q&Aの会話の永続化(Issue #603, expand)。新規テーブルのみで、
-- 既存テーブル・既存マイグレーションの変更は無い(破壊的変更なし)。
--
-- 3テーブルの責務:
--   ai_conversation … 会話の所有者・地域文脈・タイトル・同時実行制御(active_run_id)
--   ai_chat_message … 会話内の発言(ユーザの質問は推論開始前に保存、assistant本文は完了時に保存)
--   ai_chat_run     … 送信/試行ごとの実行状態(質問を複製せず再試行できるようメッセージから分離)
--
-- 同時実行: 同一会話で未完了runを複数作らないことを、会話行の active_run_id の
-- 条件付き更新(SET … WHERE active_run_id IS NULL)で担保する。送信ID(send_id)と
-- 課金requestId(billing_request_id)は一意制約で重複を弾く。
--
-- 削除: 会話→メッセージ/run、ユーザ→会話を ON DELETE cascade で連動させる。
-- 会話単位の削除は課金台帳(credit_ledger)に触れない(台帳は request_id 文字列参照のみで
-- FKを持たないため、残高・履歴に影響しない)。退会時は user 行の削除に連動して消える
-- (既存のユーザ削除ポリシーどおり)。
--
-- 地域/AOPは静的マスタ(src/lib/wine/)への文字列参照でFKは張らない。存在・所属関係の
-- 検証はサービス層で行う(既存テーブルと同一の方針)。
CREATE TABLE IF NOT EXISTS `ai_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	-- 静的マスタの Region.id。作成時の文脈として固定する
	`region_id` text NOT NULL,
	-- 静的マスタの Aop.id(任意)。作成時の文脈として固定する
	`aop_id` text,
	-- 最初の質問の先頭切り出し(LLM不使用)
	`title` text NOT NULL,
	-- 現在実行中の run の id。NULL = アイドル(送信・再試行・削除可)
	`active_run_id` text,
	-- 実行中の試行の期限。Worker中断後の再試行可否の判定に使う
	`active_run_expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 履歴一覧は「自分の会話を更新日時降順」で引く
CREATE INDEX IF NOT EXISTS `ai_conversation_user_updated_idx` ON `ai_conversation` (`user_id`,`updated_at`);
--> statement-breakpoint
-- 地域絞り込み付きの一覧用。所有権の user_id を先頭に置く
CREATE INDEX IF NOT EXISTS `ai_conversation_user_region_updated_idx` ON `ai_conversation` (`user_id`,`region_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	-- 所有権チェックを JOIN 無しで行うため冗長に持つ(WHERE id AND user_id の規約)
	`user_id` text NOT NULL,
	-- 'user' | 'assistant'
	`role` text NOT NULL,
	`content` text NOT NULL,
	-- 会話内の順序。1始まりの連番
	`sequence` integer NOT NULL,
	-- この発言を生んだ run。失敗試行の assistant 発言を履歴から除外する手掛かり。
	-- runを消しても発言自体は残す(削除は会話単位の cascade に任せる)
	`run_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `ai_chat_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- 会話内の順序付けと一意性の両方を担う
CREATE UNIQUE INDEX IF NOT EXISTS `ai_chat_message_conv_seq_uq` ON `ai_chat_message` (`conversation_id`,`sequence`);
--> statement-breakpoint
-- run から生まれた発言の引き当て(成功時の回答の復元・失敗試行の除外)
CREATE INDEX IF NOT EXISTS `ai_chat_message_run_idx` ON `ai_chat_message` (`run_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_chat_run` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	-- 所有権チェックを JOIN 無しで行うため冗長に持つ(WHERE id AND user_id の規約)
	`user_id` text NOT NULL,
	-- クライアントが採番する送信ID。同一送信IDの再送は再推論・再課金せず保存結果を返す
	`send_id` text NOT NULL,
	-- 'running' | 'succeeded' | 'failed' | 'blocked' | 'interrupted'
	`status` text NOT NULL DEFAULT 'running',
	-- 対象の質問。本文はメッセージ側に1回だけ保存し、再試行はここを参照して
	-- メッセージの重複追加をしない(再試行用のスナップショット)
	`question` text NOT NULL,
	-- 回答対象のユーザ発言の sequence
	`user_sequence` integer NOT NULL,
	-- 解決済みのモデルキー(例: gemma4)
	`model_key` text NOT NULL,
	-- 実際に呼ぶ OpenRouter モデルID(例: google/gemma-4-26b-a4b-it)
	`model_id` text NOT NULL,
	-- 実行したプロンプトの版。Langfuse が正で、fallback の回は version が NULL
	`prompt_name` text,
	`prompt_version` integer,
	`prompt_source` text,
	-- クレジット台帳の request_id(予約の冪等キー)。settle / refund はここから導出される
	`billing_request_id` text NOT NULL,
	-- 予約した表示クレジット・原価(µUSD)。確定・返却に必要
	`reserved_credits` integer,
	`reserved_micro_usd` integer,
	-- 成功時の実測(観測値)
	`actual_tokens` integer,
	`actual_micro_usd` integer,
	-- 失敗時の利用者向けの種別('llm' | 'conflict' | 'persistence')。詳細はサーバログのみ
	`error_kind` text,
	-- この試行の実行期限。この時刻を過ぎた running は中断へ遷移させ再試行可能にする
	`expires_at` integer NOT NULL,
	-- 終端(succeeded/failed/blocked/interrupted)に到達した時刻
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 送信IDの冪等キー。二重クリック・通信再送・2タブ競合をここで弾く
CREATE UNIQUE INDEX IF NOT EXISTS `ai_chat_run_send_id_uq` ON `ai_chat_run` (`send_id`);
--> statement-breakpoint
-- 課金予約の冪等キーと1対1。二重送信で同じ予約に2つの run がぶら下がらない
CREATE UNIQUE INDEX IF NOT EXISTS `ai_chat_run_billing_request_id_uq` ON `ai_chat_run` (`billing_request_id`);
--> statement-breakpoint
-- 会話の試行履歴(再試行の対象列挙・再接続時の状態復元)
CREATE INDEX IF NOT EXISTS `ai_chat_run_conv_created_idx` ON `ai_chat_run` (`conversation_id`,`created_at`);
--> statement-breakpoint
-- 期限切れ run の走査用
CREATE INDEX IF NOT EXISTS `ai_chat_run_status_expires_idx` ON `ai_chat_run` (`status`,`expires_at`);
