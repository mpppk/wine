// プレミアムプランの定義。better-auth の stripe プラグイン(サーバー)と
// 料金ページ(クライアント)の双方から参照するため、ここに集約する。

/** better-auth stripe プラグインに登録するプラン名(Stripe 側の Product 名とは独立)。 */
export const PREMIUM_PLAN_NAME = "premium";

/** 表示用の料金。実際の請求額は Stripe の Price(環境変数の price ID)が正。 */
export const PREMIUM_PRICING = {
	/** 月額(円)。JPY はゼロデシマル通貨なので Stripe 上もこの値をそのまま設定する。 */
	monthlyAmount: 300,
	/** 年額(円)。月額10ヶ月分 = 2ヶ月分お得。 */
	annualAmount: 3000,
} as const;
