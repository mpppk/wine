// 外向き fetch のホスト判定の唯一の入口(SSOT, Issue #545)。
//
// 「任意URLへのサーバ側 fetch」という同じ脅威に対する判定が3経路で別実装に
// なっていたのをここへ寄せた:
//
//  - 参考リンクのタイトル取得(`isFetchableHost`)
//  - web画像の取り込み(`isBlockedHost`)
//  - Web Push 購読の endpoint 検証(https かどうかしか見ていなかった)
//
// 片方を強化しても他方に反映されないドリフトが実際に起きていた(#148 で
// fetch-title を直したとき remote-photo は対象外だった)。新しい外向き fetch
// 経路を足すときは、ホスト判定をここ以外に書かないこと。
//
// ═══════════════════════════════════════════════════════════════════════════
// Workers 前提の一元化
// ═══════════════════════════════════════════════════════════════════════════
// Workers の fetch は内部網へ到達しないため、実害は限定的という前提は**この
// モジュールだけが持つ**。各経路のモジュールはこの前提を各自で持ち直さない。
// 将来この関数が別ランタイム(Hyperdrive / Service Bindings / Containers 等)
// から呼ばれても壊れないよう、「名前で公開ホストを指している」ことをここで
// 要求する。公開DNSが内部アドレスを返す残余リスクは、ランタイム側の egress
// 制御で塞ぐ想定( defence-in-depth の外側の層)。
//
// ポリシー:
//  - 既定は拒否。IPリテラル(v4/v6)は `allowPublicIpLiteral: true` の明示的な
//    オプトインが無い限りすべて弾く(厳しい側 = 旧 `isBlockedHost` 相当)。
//  - オプトイン時も、ループバック・プライベート・リンクローカル・ULA・未指定・
//    IPv4-mapped の偽装は旧 `isFetchableHost` の精緻判定で弾く。公開IPだけ通す。
//  - 内部向け特別名(localhost / .localhost / .local / .internal /
//    .localdomain / .home.arpa)は両モード共通で弾く。

/** `isAllowedExternalHost` の用途別オプション。 */
export interface ExternalHostOptions {
	/**
	 * 公開IPリテラル(例: `8.8.8.8`)を許可するか。既定は false(拒否)。
	 *
	 * 参考リンクのタイトル取得だけが `true` で使う(公開IPへのリンクも正当な
	 * 参考資料になりうるため。テストで固定済み)。web画像・Web Push は既定
	 * (false)のまま使うこと。
	 */
	allowPublicIpLiteral?: boolean;
}

/** IPv4ドット10進アドレスが内部/予約帯(ループバック・プライベート・リンクローカル)なら true。 */
function isBlockedIpv4(ip: string): boolean {
	const nums = ip.split(".").map((p) => Number(p));
	if (nums.length !== 4) return false;
	// 範囲外・非数値を含む見かけ上のIPv4は保守的に弾く(fetchでどのみち失敗する)
	if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = nums as [number, number, number, number];
	if (a === 0) return true; // 0.0.0.0/8(このホスト)
	if (a === 127) return true; // ループバック 127.0.0.0/8
	if (a === 10) return true; // プライベート 10.0.0.0/8
	if (a === 169 && b === 254) return true; // リンクローカル 169.254.0.0/16
	if (a === 192 && b === 168) return true; // プライベート 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true; // プライベート 172.16.0.0/12
	return false;
}

/**
 * IPv6アドレス(ブラケット除去済み)が内部/予約帯なら true。ループバック(::1)・未指定(::)・
 * ULA(fc00::/7)・リンクローカル(fe80::/10)、および IPv4-mapped/compatible(::ffff:a.b.c.d)
 * で内部IPv4を偽装したものを弾く。
 */
function isBlockedIpv6(addr: string): boolean {
	const a = addr.split("%")[0] ?? ""; // %eth0 等の zone id を除去
	if (a === "::1" || a === "::") return true;
	// IPv4-mapped(::ffff:a.b.c.d)/IPv4-compatible(::a.b.c.d)は埋め込みIPv4で判定する
	const mappedIpv4 = a.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
	if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
	const firstHextet = a.split(":")[0] ?? "";
	if (firstHextet === "") return true; // "::" で始まる短縮形は上記以外まれ。保守的に弾く
	const n = Number.parseInt(firstHextet, 16);
	if (Number.isNaN(n)) return true; // パース不能は保守的に弾く
	if (n >= 0xfc00 && n <= 0xfdff) return true; // ULA fc00::/7
	if (n >= 0xfe80 && n <= 0xfebf) return true; // リンクローカル fe80::/10
	return false;
}

/**
 * 内部向け特別名(localhost 系・RFC 6761/8375 の特別用途TLD)なら true。
 * 大文字・末尾ドットは呼び出し側で正規化済みの想定だが、ここでも吸収する。
 */
function isBlockedSpecialName(host: string): boolean {
	const h = host.toLowerCase().replace(/\.+$/, "");
	if (h === "localhost") return true;
	if (h === "" || h === "local" || h === "internal" || h === "localdomain")
		return true;
	if (h === "home.arpa") return true;
	return (
		h.endsWith(".localhost") ||
		h.endsWith(".local") ||
		h.endsWith(".internal") ||
		h.endsWith(".localdomain") ||
		h.endsWith(".home.arpa")
	);
}

/**
 * 外向き fetch してよいホストか。SSRFガードの唯一の入口。
 *
 * リダイレクト先も含め毎ホップこの関数で再検証すること(初回URLだけの検証では
 * 不十分)(#148)。`redirect: "follow"` で追跡すると初回URLだけ検証して
 * リダイレクト先(内部アドレス)を素通ししてしまうため、`redirect: "manual"`
 * で1ホップずつ辿り、毎回この関数を通すこと。
 */
export function isAllowedExternalHost(
	hostname: string,
	options: ExternalHostOptions = {},
): boolean {
	let host = hostname.toLowerCase().replace(/\.+$/, "");
	// URL.hostname は IPv6 リテラルを [..] 付きで返すことがある。外して判定する
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host === "") return false;
	if (isBlockedSpecialName(host)) return false;
	if (host.includes(":")) {
		// IPv6 リテラル。既定(厳しい側)ではすべて拒否し、オプトイン時のみ
		// 公開範囲かどうかを精緻判定する。
		if (!options.allowPublicIpLiteral) return false;
		return !isBlockedIpv6(host);
	}
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
		// IPv4 リテラル。既定ではすべて拒否(旧 isBlockedHost 相当)。
		if (!options.allowPublicIpLiteral) return false;
		return !isBlockedIpv4(host);
	}
	return true;
}
