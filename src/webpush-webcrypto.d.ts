// `webpush-webcrypto` の型宣言(Issue #466)。
//
// このパッケージは JSDoc 付きの素の ESM を配っており `.d.ts` を同梱しない。
// **使う関数だけを宣言する**——パッケージ全体を `any` に落とすと、引数名の取り違え
// (`adminContact` を `subject` と書く等)が型で止まらなくなる。ここが実物と食い違えば
// 実行時に落ちるが、それは「宣言を書いた分だけ守られる」という当たり前の範囲で、
// 何も書かない場合より狭い。
declare module "webpush-webcrypto" {
	export interface VapidKeysJSON {
		publicKey: string;
		privateKey: string;
	}

	export class ApplicationServerKeys {
		publicKey: CryptoKey;
		privateKey: CryptoKey;
		toJSON(): Promise<VapidKeysJSON>;
		static generate(): Promise<ApplicationServerKeys>;
		static fromJSON(keys: VapidKeysJSON): Promise<ApplicationServerKeys>;
	}

	export interface PushTarget {
		endpoint: string;
		keys: { p256dh: string; auth: string };
	}

	export interface GeneratePushHTTPRequestOptions {
		applicationServerKeys: ApplicationServerKeys;
		payload: string | Uint8Array;
		target: PushTarget;
		/** VAPID の `sub`。`mailto:` か `https:` のURL(RFC 8292) */
		adminContact: string;
		/** プッシュサービスが端末オフライン時に保持する秒数 */
		ttl: number;
		topic?: string;
		urgency?: "very-low" | "low" | "normal" | "high";
	}

	/**
	 * ペイロードを暗号化し、送信に必要なヘッダ・本文・宛先を返す。
	 * **送信そのものは行わない**(呼び出し側が fetch する)。
	 */
	export function generatePushHTTPRequest(
		options: GeneratePushHTTPRequestOptions,
	): Promise<{
		headers: Record<string, string>;
		body: ArrayBuffer;
		endpoint: string;
	}>;

	/**
	 * 使う WebCrypto を明示的に差し替える。既定はモジュール評価時の `self.crypto` で、
	 * 無ければ使用時に throw する(Node や、`self` を持たない実行環境向け)。
	 */
	export function setWebCrypto(crypto: Crypto): void;
}
