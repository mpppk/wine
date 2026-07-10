terraform {
  required_version = ">= 1.6"

  required_providers {
    stripe = {
      source  = "lukasaron/stripe"
      version = "~> 3.4"
    }
  }
}
