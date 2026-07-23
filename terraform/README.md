# Stripe リソースの Terraform 管理

プレミアムプラン(PR #59)が必要とする Stripe リソースを Terraform で管理する。

| リソース | 内容 |
|---|---|
| `stripe_product` | Product「プレミアム」 |
| `stripe_price` ×2 | 月額 ¥300 / 年額 ¥3,000(月額10ヶ月分) |
| `stripe_coupon` | 新規入会クーポン(既定: 90%OFF・6ヶ月・repeating) |
| `stripe_promotion_code` | 上記クーポンの入力コード(既定: `WELCOME90`。初回入会のみ) |
| `stripe_webhook_endpoint` | `/api/auth/stripe/webhook`(better-auth のサブスク同期) |
| `stripe_portal_configuration` | Billing Portal(期間末解約・支払い方法更新・請求履歴) |

## 新規入会クーポン

Checkout の標準プロモコード欄(`allow_promotion_codes`, `src/lib/auth.ts`)で適用する新規入会割引を
`stripe_coupon` / `stripe_promotion_code` で管理する。既定値は **90%OFF を 6ヶ月間(`repeating`)**、
**利用上限 100 回**、**有効期限 2026-12-31**。既存サブスクには適用できず、新規入会(初回決済)専用
(`first_time_transaction = true`)。値は module 変数で調整する:

| 変数 | 既定 | 内容 |
|---|---|---|
| `new_member_discount_percent` | `90` | 割引率(%) |
| `new_member_coupon_duration` | `repeating` | `once` / `forever` / `repeating` |
| `new_member_coupon_duration_in_months` | `6` | `repeating` 時の適用月数 |
| `new_member_coupon_max_redemptions` | `100` | 累計利用回数の上限(0 で無制限) |
| `new_member_coupon_redeem_by` | `2026-12-31T23:59:59Z` | 利用最終日時(RFC3339, 空文字で無期限) |
| `new_member_promotion_code` | `WELCOME90` | ユーザが入力するコード文字列 |

> `percent_off` / `duration` / `duration_in_months` / `max_redemptions` / `redeem_by` は Stripe 上
> `ForceNew`(変更でクーポン再作成)。既にそのクーポンで割引適用中のサブスクは、再作成後も
> 適用済みの割引を保持する(Stripe はサブスクに割引実体をコピーするため)。

プロバイダはコミュニティの [lukasaron/stripe](https://registry.terraform.io/providers/lukasaron/stripe/latest/docs) を使用する。
公式プロバイダ(stripe/stripe)は webhook 署名シークレットを出力できず、Billing Portal 設定も
未対応のため採用していない。

## ディレクトリ構成

```
terraform/
├── modules/stripe/   # 共有モジュール(リソース定義)
├── preview/          # テストモード。app_url = wine-preview.niboshi.workers.dev
└── production/       # ライブモード。app_url = wine.nibo.sh
```

state は R2 バケット `wine-terraform-state`(S3互換バックエンド)に保存する。
webhook 署名シークレットが state に平文で入るため、state バケットへのアクセスは絞ること。

## 事前準備(初回のみ)

1. **R2 APIトークン**: Cloudflare ダッシュボード → R2 → API トークンの管理 → 「wine-terraform-state」への
   オブジェクト読み取り/書き込み権限でトークンを作成し、S3互換の Access Key ID / Secret Access Key を控える
2. **Stripe APIキー**: Stripe ダッシュボード → 開発者 → APIキー。テストモード(`sk_test_...`)と
   ライブモード(`sk_live_...`)は別物で、preview / production それぞれに対応する

## 実行手順

```bash
cd terraform/preview   # 本番は terraform/production

# R2 (state) の認証情報
export AWS_ACCESS_KEY_ID=<R2のAccess Key ID>
export AWS_SECRET_ACCESS_KEY=<R2のSecret Access Key>

# Stripe の認証情報 (preview は sk_test_... / production は sk_live_...)
export STRIPE_API_KEY=<Stripeのシークレットキー>

terraform init
terraform plan
terraform apply
```

## 出力のアプリへの反映

apply 後に3つの値をアプリ側へ反映する:

```bash
# 1. price ID (公開情報) → wrangler.jsonc の vars に記入してコミット
terraform output price_id_monthly   # → STRIPE_PRICE_ID_MONTHLY
terraform output price_id_annual    # → STRIPE_PRICE_ID_ANNUAL

# 2. webhook 署名シークレット → Workers の secret へ
# preview は versions デプロイ運用のため `versions secret put`(即デプロイ型の
# `secret put` は "latest version isn't currently deployed" で弾かれる)。本番は `secret put`。
terraform output -raw webhook_secret | bunx wrangler versions secret put STRIPE_WEBHOOK_SECRET --env preview  # preview
terraform output -raw webhook_secret | bunx wrangler secret put STRIPE_WEBHOOK_SECRET                        # 本番

# 3. Stripe シークレットキー(Terraformの認証情報そのもの。Terraformでは作成不可)
bunx wrangler versions secret put STRIPE_SECRET_KEY --env preview  # sk_test_...(preview は versions secret put)
bunx wrangler secret put STRIPE_SECRET_KEY                         # sk_live_...
```

> preview 環境の secret は versions デプロイ運用のため `wrangler versions secret put` を使う。
> 新バージョンとして secret が登録され、以降のデプロイに引き継がれる(即時デプロイはされない)。

ローカル開発(`.dev.vars`)では `stripe listen --forward-to http://localhost:3000/api/auth/stripe/webhook`
が発行する一時シークレット(`whsec_...`)を使うため、Terraform の webhook_secret は使わない。

## CI (GitHub Actions)

`terraform/**` を変更すると `.github/workflows/terraform.yml` が実行される:

- **fmt チェックと validate**: 常に実行(資格情報不要。PR でも実行される)
- **plan**: **PR では実行しない**。`push`(main へのマージ)と `workflow_dispatch` でのみ実行する。
  以下の GitHub Secrets(リポジトリの Settings → Secrets and variables → Actions)が
  設定されている場合のみ実行し、未設定ならスキップして notice を出す

| Secret 名 | 内容 |
|---|---|
| `TF_R2_ACCESS_KEY_ID` | R2 APIトークンの Access Key ID(state 読み取り用) |
| `TF_R2_SECRET_ACCESS_KEY` | R2 APIトークンの Secret Access Key |
| `STRIPE_TEST_API_KEY` | テストモードの `sk_test_...`(preview の plan 用) |
| `STRIPE_LIVE_API_KEY` | ライブモードの `sk_live_...`(production の plan 用) |

plan は読み取りのみで Stripe に書き込まない。

> **PR で plan を実行しない理由(#134)**: `terraform plan` は PR ブランチの `.tf` をそのまま実行する。
> `required_providers` の差し替えや external data source の追加により、plan 時に **live Stripe キー**や
> **R2(state)認証情報**(state には webhook 署名シークレットが sensitive output として格納済み)を持つ
> プロセスで任意コードが動きうる。このためライブ資格情報を PR コンテキストに露出させず、plan は
> main マージ後(`push`)または手動実行(`workflow_dispatch`)で確認する。差分をマージ前に見たい場合は
> ローカルで `terraform plan` を実行する。

### apply の自動化 (`.github/workflows/terraform-apply.yml`)

apply も GitHub Actions で実行できる。plan(`terraform.yml`)とは別ワークフロー:

- **preview**: `main` に `terraform/**` の変更がマージされると**自動 apply**(テストモード)
- **production**: **手動実行のみ**(Actions → Terraform Apply → Run workflow で `environment=production` を選択)。
  ライブモードの課金リソースを変更するため自動 apply はしない。apply ジョブは GitHub Environment
  (`preview` / `production`)に紐付いており、**`production` に required reviewers を設定すると apply 前に
  承認待ちになる**(下記「GitHub Environments の設定」参照)
- apply 後、`webhook_secret` と Stripe APIキー(`STRIPE_SECRET_KEY`、apply に使ったキーを流用)を
  Workers に**自動投入**する(preview は versions デプロイ運用のため
  `wrangler versions secret put --env preview`、production は `wrangler secret put`)。price ID は
  コミット対象のため自動反映せず、ジョブの Summary に出力する(`wrangler.jsonc` の vars に手で反映してコミットする)
- state ロックが無いため、同一環境の apply は `concurrency` で直列化している

plan で使う4つの Secret に加えて、apply では以下が必要:

| Secret 名 | 内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `wrangler secret put` 用。Workers Scripts の編集権限を持つ R2 とは別の API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | (任意)トークンが複数アカウントに跨る場合のみ。単一アカウントなら wrangler が自動判定するため不要 |

`STRIPE_SECRET_KEY`(アプリが Stripe API を叩くためのキー)は Terraform では作成できないが、
apply ワークフローが GitHub Secrets のキー(preview は `STRIPE_TEST_API_KEY`、production は
`STRIPE_LIVE_API_KEY`)をそのまま Workers の secret へ投入する。手動での投入は不要
(手元から行う場合は上記「出力のアプリへの反映」の手順を使う)。

### GitHub Environments の設定(手動・#134)

apply ジョブ(`terraform-apply.yml`)は GitHub Environment に紐付いている
(`environment: ${{ github.event.inputs.environment || 'preview' }}`)。保護ルールと環境スコープの
secret は GitHub 上で手動設定する(ワークフロー側は環境を参照するだけ):

1. **Environment を作成**: リポジトリの Settings → Environments で `preview` と `production` を作成する
2. **production に承認ゲートを付ける**: `production` に **Required reviewers**(単独運用なら自分自身)または
   **Wait timer** を設定する。これにより `workflow_dispatch` で `production` を選んで実行しても、
   承認するまで `terraform apply -auto-approve` が走らなくなる(誤操作・環境選択ミスの一段の歯止め)
3. **live 資格情報を environment secret へ移す(推奨)**: `STRIPE_LIVE_API_KEY` と `CLOUDFLARE_API_TOKEN` を
   リポジトリレベル secret から **`production` の environment secret** へ移動する。リポジトリ secret は
   全ワークフロー・全ブランチから参照可能だが、environment secret はそのジョブがその環境で走るときにのみ
   解決されるため、ライブキーの参照可能範囲を production の apply ジョブに限定できる。同様に
   `STRIPE_TEST_API_KEY` は `preview` の environment secret にできる
   (`TF_R2_ACCESS_KEY_ID` / `TF_R2_SECRET_ACCESS_KEY` は両環境で使うためリポジトリ secret のままでもよい)

## 運用上の注意

- **Price は実質イミュータブル**: 金額変更は既存 Price の更新ではなく「新 Price 作成 → wrangler.jsonc の
  price ID 差し替え → 旧 Price を `active = false`」の手順で行う(既存サブスクリプションは旧 Price のまま継続)。
  誤 destroy 防止のため Price には `prevent_destroy` を付けている
- **モード間の分離**: preview(テストモード)と production(ライブモード)は Stripe 上完全に別空間。
  `STRIPE_API_KEY` の入れ間違いに注意(plan の差分が全リソース作成になっていたらキーを疑う)
- webhook のイベントを増やす場合は `@better-auth/stripe` が処理するイベントと突合すること
- **state ロックは無効**: R2 に DynamoDB 相当のロック機構がないため、同時に複数人が apply しない運用とする
  (現状は単独運用のため許容。必要になったら Terraform 1.10+ の `use_lockfile` の R2 対応状況を確認して導入する)
