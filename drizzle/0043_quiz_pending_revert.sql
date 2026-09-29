-- クイズの revertAnswer をサーバ側スナップショットで巻き戻す(Issue #544)。
-- 従来は回答前スナップショット(prior)をクライアントが申告し、サーバが検証せず
-- そのまま UPDATE/DELETE していた。新規テーブルのみで、既存テーブル・既存
-- マイグレーションの変更は無い(破壊的変更なし)。
--
-- quiz_pending_revert … 直前の1回答の取り消しに使う回答前スナップショット。
-- PK を user_id 単独にし、「取り消せるのは全体で最後の1回答だけ」に絞る。
-- 新しい解答で上書きされ、revert 成功で削除(消費)される。二重取り消し・
-- 未回答行の削除・任意日の減算は、行が無い/キーが違う/answered_at が合わない
-- ことで弾かれる。退会時は user 行の削除に連動して消える。
CREATE TABLE IF NOT EXISTS `quiz_pending_revert` (
	`user_id` text PRIMARY KEY NOT NULL,
	-- 直前に解答した問題キー。revert はこのキーと一致したときだけ通す
	`question_key` text NOT NULL,
	-- 解答前に対象行が存在したか(0/1)
	`existed` integer NOT NULL,
	-- 解答前の行の値。!existed のときは 0
	`correct_count` integer DEFAULT 0 NOT NULL,
	`incorrect_count` integer DEFAULT 0 NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`last_answered_at` integer,
	`last_correct_at` integer,
	-- この解答を計上した日次集計の日(JST "YYYY-MM-DD")。revert時の減算対象
	`activity_day` text NOT NULL,
	-- この解答が正解だったか(0/1)。revert時に correct を戻すために保持
	`activity_was_correct` integer NOT NULL,
	-- 解答適用後の last_answered_at。対象行が上書きされていないことの確認用
	`answered_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
