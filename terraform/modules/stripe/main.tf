# wine のプレミアムプラン(サブスクリプション)に必要な Stripe リソース一式。
# アプリ側の実装(@better-auth/stripe)が期待する構成:
#   - premium プラン = 月額 Price + 年額 Price (src/lib/auth.ts の plans 定義)
#   - webhook: /api/auth/stripe/webhook (better-auth ハンドラが受ける)
#   - Billing Portal: 解約(期間末)・支払い方法更新を許可 (profile ページの導線)

resource "stripe_product" "premium" {
  name = var.product_name
}

resource "stripe_price" "premium_monthly" {
  product     = stripe_product.premium.id
  currency    = "jpy"
  unit_amount = var.monthly_amount
  nickname    = "月額"

  recurring {
    interval       = "month"
    interval_count = 1
  }

  # 金額は既存サブスクリプションが参照するため変更不可(変更時は新 Price を作り
  # アプリ側の price ID を差し替える)。誤った作り直しを防ぐ。
  lifecycle {
    prevent_destroy = true
  }
}

resource "stripe_price" "premium_annual" {
  product     = stripe_product.premium.id
  currency    = "jpy"
  unit_amount = var.annual_amount
  nickname    = "年額(月額10ヶ月分)"

  recurring {
    interval       = "year"
    interval_count = 1
  }

  lifecycle {
    prevent_destroy = true
  }
}

# 新規入会 N%オフのクーポン。Checkout の標準プロモコード欄(allow_promotion_codes)で
# 適用される。金額割引にしたい場合は percent_off の代わりに amount_off + currency を使う。
# duration=repeating のときのみ duration_in_months(適用月数)が有効。once/forever では
# Stripe が duration_in_months を受け付けないため null を渡す。
# max_redemptions=0 は無制限、redeem_by="" は無期限として扱う。
resource "stripe_coupon" "new_member" {
  name               = var.new_member_coupon_name
  percent_off        = var.new_member_discount_percent
  duration           = var.new_member_coupon_duration
  duration_in_months = var.new_member_coupon_duration == "repeating" ? var.new_member_coupon_duration_in_months : null
  max_redemptions    = var.new_member_coupon_max_redemptions > 0 ? var.new_member_coupon_max_redemptions : null
  redeem_by          = var.new_member_coupon_redeem_by != "" ? var.new_member_coupon_redeem_by : null
}

# 上記クーポンを適用するためのプロモコード。ユーザが Checkout で入力する文字列。
# first_time_transaction で「初回(新規入会)のみ」に限定する。
resource "stripe_promotion_code" "new_member" {
  coupon = stripe_coupon.new_member.id
  code   = var.new_member_promotion_code

  restrictions {
    first_time_transaction = true
  }
}

resource "stripe_webhook_endpoint" "better_auth" {
  url         = "${var.app_url}/api/auth/stripe/webhook"
  description = "better-auth stripe plugin (subscription sync)"

  # @better-auth/stripe が購読するイベント。増やす場合はプラグインの
  # 対応イベントと突合すること。
  enabled_events = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]
}

resource "stripe_portal_configuration" "default" {
  business_profile {
    headline = "ワイン学習アプリ wine のプレミアムプラン"
  }

  default_return_url = "${var.app_url}/profile"

  features {
    invoice_history {
      enabled = true
    }

    payment_method_update {
      enabled = true
    }

    # アプリの「解約する」は期間末解約(解約予約)前提のUIなので at_period_end。
    subscription_cancel {
      enabled = true
      mode    = "at_period_end"
    }
  }
}
