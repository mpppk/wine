// スターターガイドの「閉じる」状態。ユーザ固有の状態だが学習データではなく端末側の
// 表示設定なので、D1 ではなく localStorage に置く(端末をまたぐと再表示される)。
//
// ダッシュボードは SSR され、ガイドは画面最上部に出る。クライアント側でのみ判定すると
// 閉じたユーザに毎回ちらつきとレイアウトシフトが起きるため、テーマ(src/lib/theme.ts +
// __root.tsx の THEME_INIT_SCRIPT)と同じ手法で「ペイント前に html へ属性を立て、
// CSS で隠す」形にする。SSR とハイドレーション初期描画は常に一致する(隠すのは CSS 側)。

export const STARTER_GUIDE_DISMISSED_KEY = "starter-guide-dismissed";
export const STARTER_GUIDE_DISMISSED_ATTR = "data-starter-guide-dismissed";

/**
 * ペイント前に実行するブートストラップスクリプト。__root.tsx が inline script として
 * 埋め込む。localStorage が使えない環境(プライベートモード等)では黙って何もしない。
 */
export const STARTER_GUIDE_INIT_SCRIPT = `(function(){try{if(window.localStorage.getItem('${STARTER_GUIDE_DISMISSED_KEY}')==='1'){document.documentElement.setAttribute('${STARTER_GUIDE_DISMISSED_ATTR}','1')}}catch(e){}})();`;

/** 閉じた状態を永続化し、即座に非表示にする(CSS が属性を見て隠す) */
export function dismissStarterGuide() {
	document.documentElement.setAttribute(STARTER_GUIDE_DISMISSED_ATTR, "1");
	try {
		window.localStorage.setItem(STARTER_GUIDE_DISMISSED_KEY, "1");
	} catch {
		// localStorage が使えなくても、このセッションで隠せていれば十分
	}
}
