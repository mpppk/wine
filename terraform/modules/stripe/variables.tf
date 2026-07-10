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
