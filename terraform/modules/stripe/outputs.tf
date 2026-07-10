output "product_id" {
  description = "プレミアム Product の ID"
  value       = stripe_product.premium.id
}

output "price_id_monthly" {
  description = "wrangler.jsonc の STRIPE_PRICE_ID_MONTHLY に設定する値"
  value       = stripe_price.premium_monthly.id
}

output "price_id_annual" {
  description = "wrangler.jsonc の STRIPE_PRICE_ID_ANNUAL に設定する値"
  value       = stripe_price.premium_annual.id
}

output "webhook_secret" {
  description = "wrangler secret put STRIPE_WEBHOOK_SECRET に渡す署名シークレット"
  value       = stripe_webhook_endpoint.better_auth.secret
  sensitive   = true
}

output "portal_configuration_id" {
  description = "Billing Portal 設定の ID"
  value       = stripe_portal_configuration.default.id
}
