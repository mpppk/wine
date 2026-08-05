// idApp の帯規約のうち、TS 側(src/lib/wine/types.ts)と geodata 生成スクリプトの
// 両方が使う定数。**唯一の情報源は src/lib/wine/geo-bands.json** で、TS はそれを
// import し、Node スクリプトはこのモジュール経由で読む(Issue #407)。
//
// 以前は同じ値が types.ts と build-aop-geodata.mjs / build-aop-centroids.mjs に
// リテラルで3重複製されていた。合成IDバンドは 900001/910001/920001/930001 と
// 積み増しされてきた実績があり境界値は動きうるが、同期漏れしても**生成物が無言で
// 変わるだけ**で、data-integrity.test.ts は TS 側の定数としか突き合わせないため
// 「古い定数で生成された成果物」との乖離を検出できなかった。
//
// JSON を import attributes ではなく fs で読むのは、スクリプトの実行系
// (node / bun)を問わず同じように動かすため。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bands = JSON.parse(
	fs.readFileSync(path.join(ROOT, "src/lib/wine/geo-bands.json"), "utf8"),
);

/**
 * これ以上の idApp は INAO の独立ポリゴンを持たない(地図に描かない)エントリ帯
 * (ブルゴーニュのクリマ・合成総称ノード)。ジオメトリ/重心の生成・整合チェックは
 * この値以上の idApp を対象外にする。
 */
export const POLYGONLESS_IDAPP_MIN = bands.polygonlessIdAppMin;
