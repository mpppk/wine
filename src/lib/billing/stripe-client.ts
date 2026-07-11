import { env } from "cloudflare:workers";
import Stripe from "stripe";

// Stripe クライアントを一箇所で構築して使い回す。better-auth の stripe プラグイン
// (auth.ts)と、既存サブスクを直接操作する延長サービス(billing-service.ts)の双方が
// 同じ設定で Stripe API を叩けるようにする。
//
// Stripe キー未設定でもアプリが起動するようプレースホルダで初期化する。
// Stripe API 呼び出し時に初めて失敗するので、ログイン等の既存機能には影響しない
// (ローカル開発・CI ビルドは未設定で動く前提)。
export const stripeClient = new Stripe(
	env.STRIPE_SECRET_KEY || "sk_test_placeholder",
	{
		// Workers では Node の http エージェントではなく fetch ベースのクライアントを使う。
		httpClient: Stripe.createFetchHttpClient(),
	},
);
