-- 孤児クレジット予約の回収(#246)の前提を整える、既存データの補填。
--
-- 本変更以降、確定(settle)は差分が0でも `<予約ID>:settle` の台帳行(amount=0)を必ず残す。
-- 「:settle も :refund も無い consume」= 打ち切りで宙に浮いた予約、と機械的に判定できる
-- ようにするため(credit-service.reclaimOrphanReservations)。
--
-- ところが本変更以前は差分0の確定が台帳に何も書かなかったため、既存の consume 行には
-- 「正常に消費し切った予約」と「孤児」が区別なく混在している。そのまま回収を有効にすると
-- 前者まで返却してしまう(=クレジットの二重取り)。
--
-- そこで、適用時点で :settle も :refund も持たない consume をすべて「確定済み」として
-- マーカー行で塗り潰し、回収の対象から外す。孤児だったものを取りこぼす方向の誤りだが、
-- ユーザ不利になる誤りではない(残高は既に引かれたまま据え置き)ので安全側に倒す。
-- 以降に作られる予約は確定/返却のいずれかが必ず記録されるため、この補填は一度きりで足りる。
--
-- 冪等: NOT EXISTS で対象を絞り、request_id の unique に対して INSERT OR IGNORE する。
-- 再適用しても新たな行は入らない。既存行の更新・削除は行わない(非破壊)。
INSERT OR IGNORE INTO credit_ledger
	(id, user_id, amount, type, request_id, period_month, token_amount, created_at)
SELECT
	lower(hex(randomblob(16))),
	c.user_id,
	0,
	'refund',
	c.request_id || ':settle',
	c.period_month,
	c.token_amount,
	cast(unixepoch('subsecond') * 1000 as integer)
FROM credit_ledger c
WHERE c.type = 'consume'
	AND NOT EXISTS (
		SELECT 1 FROM credit_ledger m WHERE m.request_id = c.request_id || ':settle'
	)
	AND NOT EXISTS (
		SELECT 1 FROM credit_ledger m WHERE m.request_id = c.request_id || ':refund'
	);
