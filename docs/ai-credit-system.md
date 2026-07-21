# AI クレジットシステム 設計

ユーザに毎月クレジットを付与し、AI 機能（地域への質問チャット、エチケット画像からの項目抽出など）を
使うとクレジットを消費する仕組みの設計をまとめる。無料会員よりプレミアム会員の方が毎月の付与
クレジット数が多い。コード配置・レイヤ構成を含む全体像は [docs/architecture.md](./architecture.md) を参照。

## 設計判断

| 項目 | 決定 | 補足 |
|---|---|---|
| 提供面 | Web UI ＋ MCP の両方 | **共通の残高プール**を両面で共有する |
| 推論の担い手 | Cloudflare Workers AI（サーバー側推論） | MCP 経由でもクライアントのモデルには委ねず、自前で推論・課金する |
| 消費粒度 | トークン従量 | 内部はトークン精度（`tokenAmount`）で計上する |
| 表示単位 | 抽象クレジット（丸めた数字） | 生トークン数はユーザに見せない。換算は `TOKENS_PER_CREDIT`（切り上げ＝過小請求防止） |
| 残高不足時 | その月はブロック＋アップグレード誘導 | 追加購入・翌月繰越は行わない。throw ではなく `{ blocked: true }` を返す |
| 付与タイミング | 暦月一律（JST）の遅延付与 | Cron は使わない（後述） |
| 付与数 | 無料 < プレミアム | 定数は `src/lib/billing/plans.ts` が正（後述） |

> **なぜ「両面共有 × Workers AI」か**: MCP 経由でもサーバー側（Workers AI）で推論するため、
> Web UI・MCP のどちらから使っても同じ推論経路・同じ残高を通る。「MCP はクライアント（Claude 等）の
> モデルに委ねる」構成ではないので、MCP 利用時も実コストが自社に発生し、クレジット消費の対象になる。

## データモデル

**台帳方式（append-only ledger）＋ 残高キャッシュ**を採用する。付与・消費・返却をすべて追記する
ことで、履歴表示・監査・二重消費防止を一枚岩で解く。テーブル定義の正は `src/db/schema.ts`
（`credit_ledger` / `credit_balance`）、D1 アクセスは `src/lib/services/credit-service.ts`。

- **`credit_ledger`（追記専用台帳）** — `amount` は符号付きの表示クレジット（付与＋ / 消費− / 返却＋）、
  `tokenAmount` は内部精度の見積/実測トークン。`type` は `grant` / `consume` / `refund` /
  `admin_grant`（管理者の理由付き手動付与）。`requestId` は unique の冪等キーで、月次付与は
  `grant:{userId}:{YYYY-MM}`、消費は用途プレフィックス付き UUID（例 `ask_region:{uuid}`）、
  確定/返却は予約 ID に `:settle` / `:refund` を付けて導出する。
- **`credit_balance`（残高キャッシュ）** — `userId` を PK に現在残高を保持する（台帳の SUM を毎回
  引かないため）。台帳への追記と**同一の `db.batch`** で更新し、常に整合させる。`periodMonth`
  （JST の `"YYYY-MM"`）が残高の属する付与月で、月が変わると付与時にリセットされる。

## 消費フロー（予約 → 確定）

トークン従量では消費量が事前に確定しないため、**予約（reserve）→ 実測確定（settle）**方式を採る。
実装は `credit-service.ts` の `reserveCredits` / `settleReservation` / `refundReservation` で、
消費者は `src/lib/services/ai-service.ts`（地域 Q&A・エチケット解析）。

1. **最低残高チェック** — 残高が最大見積を下回るならブロック。推論は開始せず、アップグレード誘導を返す。
2. **予約** — 最大見積分を `consume` として仮計上し、残高から引く（`request_id` 付き）。
3. **推論実行** — Workers AI を呼ぶ。
4. **確定・差分返却** — 実測トークンを換算し、予約との差分を `refund` で戻す。
   推論失敗時は予約全額を `refund` で戻す。

```
[残高チェック] → NG → ブロック（アップグレード誘導）
      │ OK
[予約: consume -max]
      │
[Workers AI 実行] → 失敗 → [refund +max]（全額返却）
      │ 成功
[settle: refund +(max - 実測)]（差分返却）
```

> **なぜ予約するのか**: 残高不足ブロックを「推論後」に判定すると、コストだけ発生して課金できない
> ケースが生まれる。先に最大見積を押さえることで、必ず残高の範囲内で推論する。

- 見積は「予約が実測を必ず上回る」保守的な値にする。実測トークン（`usage.total_tokens`）が取得
  できないモデルでは予約全量を実測とみなす（返却 0 の安全側）。
- 1 回の予約は `AI_MAX_ESTIMATE_TOKENS` でキャップする（暴走・過大請求のガード）。

## 整合性・同時実行

Web UI と MCP の両面から同一残高を同時に叩けるため、二重消費・残高マイナスを防ぐ設計が要になる。

- **冪等キー** — `credit_ledger.request_id` の unique 制約で再送・二重計上を弾く。
- **残高の負値禁止** — 消費は `WHERE balance >= 必要量` を条件とした**条件付き UPDATE** でのみ減算し、
  空結果＝残高不足としてブロックする（Durable Object による直列化は採用していない）。
- **原子性** — D1 にトランザクションはないため、台帳追記と残高更新は同一 `db.batch` で行う。

## 月次付与（遅延付与）

Cron は使わず、**残高参照・消費の入口で必ず `ensureCurrentMonthGranted` を呼ぶ遅延付与**方式。
新しい月（JST 暦月）の最初のアクセス時に、台帳へ `grant` を追記し残高を付与額へリセットする
（繰越なし＝前月残は失効）。

- `requestId = grant:{userId}:{YYYY-MM}` と、`periodMonth <> 当月` を条件とする更新で
  二重付与・同月への二重リセット（＝消費の巻き戻し）を防ぐ。
- **閲覧が付与を起こしてはいけない文脈**（管理画面の残高表示など）では credit-service を経由せず
  `credit_balance` を生 SELECT する（`admin-service.ts` の方針）。
- 管理者の手動付与（`admin_grant`）は当月残高への加算であり、翌月の月次リセットで失効する
  （繰越なしの仕様に合わせた挙動）。

## UX

- **残高表示** — ヘッダに現在クレジットを表示。取得中は確定表示を出さない（フラッシュ回避。
  `shouldShowAds` と同じ考え方）。
- **残高不足導線** — ブロック時はプレミアムのメリット（付与数の多さ）を示すアップグレード誘導。
- **MCP 側のブロック表現** — クレジット不足を構造化エラー（`isError: true` ＋残高・必要量の説明）で
  返し、クライアントに「アップグレードで解決する」ことを伝える。

## 数値（暫定）

付与数・換算比は `src/lib/billing/plans.ts` の定数が正で、Workers AI の原価を見て値のみ差し替える:
`MONTHLY_CREDITS_FREE` / `MONTHLY_CREDITS_PREMIUM` / `TOKENS_PER_CREDIT` / `AI_MAX_ESTIMATE_TOKENS`。
