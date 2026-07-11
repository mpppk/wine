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
  default     = "新規入会割引"
}

variable "new_member_discount_percent" {
  description = "新規入会クーポンの割引率(%)。1〜100。"
  type        = number
  default     = 10

  validation {
    condition     = var.new_member_discount_percent > 0 && var.new_member_discount_percent <= 100
    error_message = "new_member_discount_percent は 1〜100 で指定してください。"
  }
}

variable "new_member_coupon_duration" {
  description = "クーポンの適用期間。once(初回のみ)/ forever / repeating。"
  type        = string
  default     = "once"

  validation {
    condition     = contains(["once", "forever", "repeating"], var.new_member_coupon_duration)
    error_message = "new_member_coupon_duration は once / forever / repeating のいずれか。"
  }
}

variable "new_member_promotion_code" {
  description = "ユーザが Checkout で入力するプロモコード文字列。"
  type        = string
  default     = "WELCOME10"
}
