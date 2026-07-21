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

// AIクレジットの付与・換算の定数。いずれも暫定値であり、Workers AI の原価が見えた
// 段階で数値のみ差し替える(docs/ai-credit-system.md の「数値（暫定）」)。
// クレジットの内部計上はトークン精度で行い、ユーザ表示はここでの換算比で丸めた整数。

/** 無料会員に毎月付与するクレジット数(暫定)。無料 < プレミアム。 */
export const MONTHLY_CREDITS_FREE = 50;
/** プレミアム会員に毎月付与するクレジット数(暫定)。 */
export const MONTHLY_CREDITS_PREMIUM = 500;
/** 内部トークン → 表示クレジットの換算比(暫定)。1クレジット = このトークン数。 */
export const TOKENS_PER_CREDIT = 1000;

/**
 * 1回のAI消費で予約できる最大見積トークン(暴走・過大請求のガード)。予約はこの値で
 * キャップされ、consume系エンドポイントの入力バリデーション上限とも揃える。
 */
export const AI_MAX_ESTIMATE_TOKENS = 100_000;
