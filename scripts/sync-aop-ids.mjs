// aops.json の ID を「これまでに出荷された ID の台帳」(aop-known-ids.json)へ追記する。
//
// drunk_wine.aop_id / aop_reference_link.aop_id は FK 無しでこの ID を参照するため、
// ID の削除・改名は本番D1の行を静かに孤児化させる(#333)。台帳と data-integrity テストが
// 「削除・改名は RETIRED_AOP_IDS への明記を必須にする」というガードを機械化する。
//
// この台帳は **append-only**。ここでは決して ID を削らない(削るとガードが無効化される)。
// AOP を足したら `bun run sync:aop-ids` を実行して差分をコミットする。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.resolve(
	path.dirname(url.fileURLToPath(import.meta.url)),
	"..",
);
const aopsPath = path.join(root, "src/lib/wine/aops.json");
const ledgerPath = path.join(root, "src/lib/wine/aop-known-ids.json");

const current = JSON.parse(fs.readFileSync(aopsPath, "utf8")).map((a) => a.id);
const known = fs.existsSync(ledgerPath)
	? JSON.parse(fs.readFileSync(ledgerPath, "utf8"))
	: [];

const merged = [...new Set([...known, ...current])].sort();
const added = merged.filter((id) => !known.includes(id));

fs.writeFileSync(ledgerPath, `${JSON.stringify(merged, null, "\t")}\n`);

console.log(
	`aop-known-ids.json: ${merged.length} ids (${added.length} added, ${current.length} currently shipped)`,
);
for (const id of added) console.log(`  + ${id}`);
