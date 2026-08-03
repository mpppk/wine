// プレミアムプランの定義。better-auth の stripe プラグイン(サーバー)と
// 料金ページ(クライアント)の双方から参照するため、ここに集約する。

/** better-auth stripe プラグインに登録するプラン名(Stripe 側の Product 名とは独立)。 */
export const PREMIUM_PLAN_NAME = "premium";

/**
 * 新規プレミアム入会時の無料トライアル日数。全新規会員に一律で付与する。
 * auth.ts のプラン定義(freeTrial)と料金ページの表示の双方から参照する。
 */
export const PREMIUM_TRIAL_DAYS = 7;

/** 表示用の料金。実際の請求額は Stripe の Price(環境変数の price ID)が正。 */
export const PREMIUM_PRICING = {
	/** 月額(円)。JPY はゼロデシマル通貨なので Stripe 上もこの値をそのまま設定する。 */
	monthlyAmount: 300,
	/** 年額(円)。月額10ヶ月分 = 2ヶ月分お得。 */
	annualAmount: 3000,
} as const;

// AIクレジットの月次付与量。**原価から逆算した値**であり、勘で置いた数字ではない(#355)。
//
// クレジットの内部計上はコスト単位(µUSD)で行う。1クレジット = $0.001
// (`MICRO_USD_PER_CREDIT`、src/lib/billing/ai-pricing.ts)なので、付与数はそのまま
// 「その会員に毎月許容する AI 原価の上限」を意味する。
//
//   無料     150 クレジット = $0.15/月
//   プレミアム 1500 クレジット = $1.50/月
//
// プレミアムは ¥300/月(Stripe 手数料後で約 $1.87)なので、付与枠を最も高価な経路で
// 使い切られても収益内に収まる。無料は広告収益で賄う前提の販促枠。
//
// **この数値を動かすときは原価予算として動かす**。1操作あたりの消費は単価表から
// 自動的に決まるので、ここだけを上げると許容原価がそのまま増える。

/** 無料会員に毎月付与するクレジット数(= 許容原価 $0.15/月)。無料 < プレミアム。 */
export const MONTHLY_CREDITS_FREE = 150;
/** プレミアム会員に毎月付与するクレジット数(= 許容原価 $1.50/月)。 */
export const MONTHLY_CREDITS_PREMIUM = 1500;
