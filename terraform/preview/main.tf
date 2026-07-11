# プレビュー環境用の Stripe リソース(テストモード)。
# 認証: STRIPE_API_KEY にテストモードのシークレットキー(sk_test_...)を設定して実行する。
# state は R2 (S3互換) バケット wine-terraform-state に保存する。
# R2 の APIトークン(S3互換認証情報)を AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY で渡す。

terraform {
  required_version = ">= 1.6"

  backend "s3" {
    bucket = "wine-terraform-state"
    key    = "stripe/preview.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://e3e66e02919ba2916b412cba4009f5c0.r2.cloudflarestorage.com"
    }

    # R2 は AWS ではないため、AWS 固有の検証・API をすべてスキップする。
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }

  required_providers {
    stripe = {
      source  = "lukasaron/stripe"
      version = "~> 3.4"
    }
  }
}

# api_key は STRIPE_API_KEY 環境変数から読まれる(tf ファイルにキーを書かない)。
provider "stripe" {}

module "stripe" {
  source = "../modules/stripe"

  # プレビューの固定ドメイン。webhook はプレビュー環境共通でこの1本。
  app_url = "https://wine-preview.niboshi.workers.dev"
}

output "price_id_monthly" {
  value = module.stripe.price_id_monthly
}

output "price_id_annual" {
  value = module.stripe.price_id_annual
}

output "webhook_secret" {
  value     = module.stripe.webhook_secret
  sensitive = true
}

output "new_member_promotion_code" {
  value = module.stripe.new_member_promotion_code
}
