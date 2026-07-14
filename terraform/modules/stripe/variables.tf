variable "app_url" {
  description = "アプリの公開URL(末尾スラッシュなし)。webhook と Billing Portal の戻り先の基準になる。"
  type        = string

  validation {
    condition     = !endswith(var.app_url, "/")
    error_message = "app_url は末尾スラッシュなしで指定してください。"
  }
}

variable "product_name" {
  description = "Stripe 上の Product 名(Checkout や請求書に表示される)。"
  type        = string
  default     = "プレミアム"
}

variable "monthly_amount" {
  description = "月額料金(円)。JPY はゼロデシマル通貨なので円単位の整数をそのまま指定する。"
  type        = number
  default     = 300
}

variable "annual_amount" {
  description = "年額料金(円)。月額10ヶ月分(2ヶ月分お得)。"
  type        = number
  default     = 3000
}

# ── 新規入会 N%オフ クーポン ────────────────────────────────────────────────

variable "new_member_coupon_name" {
  description = "新規入会クーポンの表示名(Checkout・請求書に表示)。"
  type        = string
  default     = "新規入会90%OFF(6ヶ月)"
}

variable "new_member_discount_percent" {
  description = "新規入会クーポンの割引率(%)。1〜100。"
  type        = number
  default     = 90

  validation {
    condition     = var.new_member_discount_percent > 0 && var.new_member_discount_percent <= 100
    error_message = "new_member_discount_percent は 1〜100 で指定してください。"
  }
}

variable "new_member_coupon_duration" {
  description = "クーポンの適用期間。once(初回のみ)/ forever / repeating。"
  type        = string
  default     = "repeating"

  validation {
    condition     = contains(["once", "forever", "repeating"], var.new_member_coupon_duration)
    error_message = "new_member_coupon_duration は once / forever / repeating のいずれか。"
  }
}

variable "new_member_coupon_duration_in_months" {
  description = "duration=repeating のとき割引を適用する月数(1以上)。duration が repeating 以外なら無視される。"
  type        = number
  default     = 6

  validation {
    condition     = var.new_member_coupon_duration_in_months >= 1
    error_message = "new_member_coupon_duration_in_months は 1 以上の整数で指定してください。"
  }
}

variable "new_member_coupon_max_redemptions" {
  description = "クーポンの累計利用回数の上限。0 を指定すると無制限。"
  type        = number
  default     = 100

  validation {
    condition     = var.new_member_coupon_max_redemptions >= 0
    error_message = "new_member_coupon_max_redemptions は 0(無制限)以上で指定してください。"
  }
}

variable "new_member_coupon_redeem_by" {
  description = "クーポンを利用できる最終日時(RFC3339, 例: 2026-12-31T23:59:59Z)。空文字なら無期限。"
  type        = string
  default     = "2026-12-31T23:59:59Z"

  validation {
    condition     = var.new_member_coupon_redeem_by == "" || can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.new_member_coupon_redeem_by))
    error_message = "new_member_coupon_redeem_by は空文字、または RFC3339(末尾 Z)形式で指定してください。例: 2026-12-31T23:59:59Z"
  }
}

variable "new_member_promotion_code" {
  description = "ユーザが Checkout で入力するプロモコード文字列。"
  type        = string
  default     = "WELCOME90"
}
