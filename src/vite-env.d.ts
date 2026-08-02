/// <reference types="vite/client" />

// ビルド時にクライアントへ埋め込む変数の型宣言。**`VITE_` 接頭辞のものはバンドルに
// そのまま入る = 公開値**なので、シークレットはここに置かない(シークレットは
// `src/env-secrets.d.ts` の Cloudflare.Env 側で、サーバでのみ読む)。
interface ImportMetaEnv {
	/**
	 * クライアントのエラー収集先(Sentry)の DSN。Sentry の DSN は設計上公開情報で、
	 * イベントの投函先を指すだけ。**未設定なら収集を丸ごと無効化する**ので、ローカルと
	 * CI では設定しない(SDK も読み込まれない)。
	 */
	readonly VITE_SENTRY_DSN?: string;
	/**
	 * リリース識別子。アップロードしたソースマップとイベントを結びつけるために使う。
	 * Cloudflare Workers Builds ではビルド環境変数のコミットSHAを渡す。
	 */
	readonly VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
