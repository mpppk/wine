-- Issue #643: ai_chat_run.send_id の一意スコープを全体から (user_id, send_id) へ移す。
-- 冪等キーの意味は「このユーザのこの送信」なので、制約も所有者スコープが自然。
-- 他ユーザの send_id と衝突したとき、旧全体uniqueは insert を弾くのに所有者スコープの
-- 再読込は見つからず、生の D1 エラーが 500 になっていた(send_id はクライアント採番UUID
-- のため実害はほぼ無いが、モデルとして不整合)。
--
-- expand-and-contract の1ファイル段階化: 新複合uniqueを追加してから旧全体uniqueを削除する。
-- 旧全体uniqueが保たれていれば新複合uniqueは自動的に保たれるため、既存行の backfill は不要。
-- 旧コード×新スキーマの window でも旧コードの INSERT は通り(制約緩和のみ)、新コード×旧スキーマ
-- でも所有者スコープの重複確認は全体uniqueの部分集合として保たれる。
CREATE UNIQUE INDEX IF NOT EXISTS `ai_chat_run_user_send_id_uq` ON `ai_chat_run` (`user_id`,`send_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `ai_chat_run_send_id_uq`;
