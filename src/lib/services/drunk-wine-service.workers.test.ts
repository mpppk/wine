import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { drunkWine, wineTasting } from "#/db/schema";
import {
	addWineTasting,
	createDrunkWine,
	deleteDrunkWine,
	deleteWineTasting,
	getCellarSummary,
	listWineTastings,
	markWineDrunk,
	updateLatestWineTasting,
	updateWineTasting,
} from "./drunk-wine-service";

// D1(実SQLite)上で、所有状態(status)と飲用記録(wine_tasting)の2軸モデルを検証する。
// 集計キャッシュ(tasting_count / last_drank_on)は相関サブクエリによる全再計算で
// 更新しており、加算・減算では守れない挙動(削除で MAX が次に大きい値へ戻る等)を
// 実クエリでないと確認できない。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `dw-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "cellar tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

/** サービス層を経由せずに行を直接読む(副作用の確認用)。 */
async function wineRow(id: string) {
	const [row] = await db.select().from(drunkWine).where(eq(drunkWine.id, id));
	return row;
}

async function tastingRows(drunkWineId: string) {
	return db
		.select()
		.from(wineTasting)
		.where(eq(wineTasting.drunkWineId, drunkWineId))
		.orderBy(desc(wineTasting.createdAt));
}

describe("createDrunkWine の所有状態と飲用記録", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("status 未指定は finished になり、飲用記録が1件できる(旧UXの継承)", async () => {
		const entry = await createDrunkWine(userId, { name: "Chablis" });
		expect(entry.status).toBe("finished");
		expect(entry.tastingCount).toBe(1);
		expect(entry.lastDrankOn).toBeNull();

		const rows = await tastingRows(entry.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.drankOn).toBeNull();
	});

	it("wishlist は飲用記録を作らない", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Corton-Charlemagne",
			status: "wishlist",
		});
		expect(entry.tastingCount).toBe(0);
		expect(await tastingRows(entry.id)).toHaveLength(0);
	});

	it("owned は飲用記録を作らない(買ったがまだ飲んでいない)", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Meursault",
			status: "owned",
		});
		expect(entry.status).toBe("owned");
		expect(entry.tastingCount).toBe(0);
	});

	it("owned + 飲用記録で「以前飲んで、また買った」を表現できる", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Morgon",
			status: "owned",
			tasting: { drankOn: "2020-05-05", rating: 4 },
		});
		// 2軸が独立しているので、手元にある かつ 飲んだことがある が同時に成り立つ
		expect(entry.status).toBe("owned");
		expect(entry.tastingCount).toBe(1);
		expect(entry.lastDrankOn).toBe("2020-05-05");
	});

	it("finished に飲用記録を明示すればその値が入る", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Sancerre",
			status: "finished",
			tasting: { drankOn: "2021-03-03", rating: 5, memo: "好み" },
		});
		expect(entry.tastingCount).toBe(1);
		expect(entry.lastDrankOn).toBe("2021-03-03");
		expect(entry.rating).toBe(5);
		expect(entry.memo).toBe("好み");
	});
});

describe("集計キャッシュの再計算", () => {
	let userId: string;
	let wineId: string;
	beforeEach(async () => {
		userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "Gevrey-Chambertin",
			status: "owned",
		});
		wineId = entry.id;
	});

	it("複数追加すると件数が増え、last_drank_on は挿入順でなく MAX になる", async () => {
		await addWineTasting(userId, wineId, { drankOn: "2022-06-01" });
		await addWineTasting(userId, wineId, { drankOn: "2024-01-01" });
		const entry = await addWineTasting(userId, wineId, {
			drankOn: "2023-03-03",
		});
		expect(entry.tastingCount).toBe(3);
		expect(entry.lastDrankOn).toBe("2024-01-01");
	});

	it("最新を削除すると last_drank_on が次に大きい値へ戻る", async () => {
		await addWineTasting(userId, wineId, { drankOn: "2022-06-01" });
		const latest = await addWineTasting(userId, wineId, {
			drankOn: "2024-01-01",
		});
		expect(latest.lastDrankOn).toBe("2024-01-01");

		const rows = await tastingRows(wineId);
		const newest = rows.find((r) => r.drankOn === "2024-01-01");
		const after = await deleteWineTasting(userId, newest?.id ?? "");
		// 減算では表現できない挙動。全再計算にしている理由
		expect(after.tastingCount).toBe(1);
		expect(after.lastDrankOn).toBe("2022-06-01");
	});

	it("日付未入力の記録が混ざっても MAX が壊れない", async () => {
		await addWineTasting(userId, wineId, {});
		const entry = await addWineTasting(userId, wineId, {
			drankOn: "2023-08-08",
		});
		expect(entry.tastingCount).toBe(2);
		expect(entry.lastDrankOn).toBe("2023-08-08");
	});

	it("全件が日付未入力なら last_drank_on は null", async () => {
		await addWineTasting(userId, wineId, { rating: 3 });
		const entry = await addWineTasting(userId, wineId, { rating: 4 });
		expect(entry.tastingCount).toBe(2);
		expect(entry.lastDrankOn).toBeNull();
	});

	it("旧列は最新1件の射影として二重書きされる", async () => {
		await addWineTasting(userId, wineId, {
			drankOn: "2022-06-01",
			rating: 2,
			memo: "古い",
		});
		await addWineTasting(userId, wineId, {
			drankOn: "2024-01-01",
			rating: 5,
			memo: "新しい",
		});
		const row = await wineRow(wineId);
		expect(row?.drankOn).toBe("2024-01-01");
		expect(row?.drankOn).toBe(row?.lastDrankOn);
		expect(row?.rating).toBe(5);
		expect(row?.memo).toBe("新しい");
	});

	it("同じ日の2件では created_at の新しい方が最新になる", async () => {
		await addWineTasting(userId, wineId, { drankOn: "2024-01-01", memo: "先" });
		await addWineTasting(userId, wineId, { drankOn: "2024-01-01", memo: "後" });
		const row = await wineRow(wineId);
		expect(row?.memo).toBe("後");
	});

	it("飲用記録の更新でも再計算される", async () => {
		const added = await addWineTasting(userId, wineId, {
			drankOn: "2022-06-01",
		});
		const rows = await tastingRows(wineId);
		const target = rows[0];
		expect(added.lastDrankOn).toBe("2022-06-01");

		const after = await updateWineTasting(userId, {
			id: target?.id ?? "",
			drankOn: "2025-02-02",
		});
		expect(after.lastDrankOn).toBe("2025-02-02");
	});
});

describe("markWineDrunk", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("飲用記録の追加と status='finished' が同時に反映される", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Volnay",
			status: "owned",
		});
		const after = await markWineDrunk(userId, entry.id, {
			drankOn: "2026-07-01",
		});
		expect(after.status).toBe("finished");
		expect(after.tastingCount).toBe(1);
		expect(after.lastDrankOn).toBe("2026-07-01");
	});

	it("日付を省略すると今日(JST)が入る", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Pommard",
			status: "owned",
		});
		const after = await markWineDrunk(userId, entry.id);
		expect(after.lastDrankOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("2回目の「飲んだ」で記録が増える(買い直して再度飲んだケース)", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Fleurie",
			status: "owned",
		});
		await markWineDrunk(userId, entry.id, { drankOn: "2025-01-01" });
		const after = await markWineDrunk(userId, entry.id, {
			drankOn: "2026-01-01",
		});
		expect(after.tastingCount).toBe(2);
		expect(after.lastDrankOn).toBe("2026-01-01");
	});
});

describe("updateLatestWineTasting (MCPレガシー引数)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("2回呼んでも件数が増えない(最新1件の in-place 更新)", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Chinon",
			tasting: { drankOn: "2020-01-01" },
		});
		await updateLatestWineTasting(userId, entry.id, { drankOn: "2021-01-01" });
		const after = await updateLatestWineTasting(userId, entry.id, {
			drankOn: "2022-01-01",
		});
		// MCP App は保存のたびに update_drunk_wine を投げる。追加にすると増え続ける
		expect(after?.tastingCount).toBe(1);
		expect(after?.lastDrankOn).toBe("2022-01-01");
	});

	it("飲用記録が0件なら、非nullの値があるときだけ1件作る", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Vouvray",
			status: "wishlist",
		});
		expect(entry.tastingCount).toBe(0);

		const noop = await updateLatestWineTasting(userId, entry.id, {
			drankOn: null,
			rating: null,
		});
		expect(noop).toBeNull();
		expect((await wineRow(entry.id))?.tastingCount).toBe(0);

		const created = await updateLatestWineTasting(userId, entry.id, {
			rating: 4,
		});
		expect(created?.tastingCount).toBe(1);
	});

	it("null は列のクリアであって記録の削除ではない", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Bandol",
			tasting: { drankOn: "2020-01-01", rating: 3 },
		});
		const after = await updateLatestWineTasting(userId, entry.id, {
			drankOn: null,
		});
		expect(after?.tastingCount).toBe(1);
		expect(after?.lastDrankOn).toBeNull();
		// 記録の行は残り、他の列も保持される
		const rows = await tastingRows(entry.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.rating).toBe(3);
	});

	it("status は変えない(2軸は独立。暗黙の遷移は markWineDrunk だけ)", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Cahors",
			status: "owned",
		});
		await updateLatestWineTasting(userId, entry.id, { drankOn: "2026-01-01" });
		expect((await wineRow(entry.id))?.status).toBe("owned");
	});
});

describe("所有権とカスケード", () => {
	it("他ユーザのエントリ・飲用記録への操作は Entry not found", async () => {
		const owner = await freshUser();
		const other = await freshUser();
		const entry = await createDrunkWine(owner, { name: "Barolo" });
		const rows = await tastingRows(entry.id);
		const tastingId = rows[0]?.id ?? "";

		await expect(
			addWineTasting(other, entry.id, { rating: 3 }),
		).rejects.toThrow("Entry not found");
		await expect(listWineTastings(other, entry.id)).rejects.toThrow(
			"Entry not found",
		);
		await expect(
			updateWineTasting(other, { id: tastingId, rating: 1 }),
		).rejects.toThrow("Entry not found");
		await expect(deleteWineTasting(other, tastingId)).rejects.toThrow(
			"Entry not found",
		);
		await expect(markWineDrunk(other, entry.id)).rejects.toThrow(
			"Entry not found",
		);
	});

	it("銘柄を削除すると飲用記録も消える(FK cascade)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "Barbaresco",
			tasting: { drankOn: "2020-01-01" },
		});
		expect(await tastingRows(entry.id)).toHaveLength(1);

		await deleteDrunkWine(userId, entry.id);
		expect(await tastingRows(entry.id)).toHaveLength(0);
	});
});

describe("listWineTastings の並び", () => {
	it("日付の新しい順で、日付未入力は末尾に来る", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "Chianti",
			status: "owned",
		});
		await addWineTasting(userId, entry.id, { drankOn: "2022-01-01" });
		await addWineTasting(userId, entry.id, {});
		await addWineTasting(userId, entry.id, { drankOn: "2024-01-01" });

		const list = await listWineTastings(userId, entry.id);
		expect(list.map((t) => t.drankOn)).toEqual([
			"2024-01-01",
			"2022-01-01",
			null,
		]);
	});
});

describe("getCellarSummary", () => {
	it("飲んだ銘柄数と登録総数を別に数える", async () => {
		const userId = await freshUser();
		await createDrunkWine(userId, { name: "飲んだ1" });
		await createDrunkWine(userId, { name: "飲んだ2" });
		await createDrunkWine(userId, { name: "在庫", status: "owned" });
		await createDrunkWine(userId, { name: "気になる", status: "wishlist" });

		const summary = await getCellarSummary(userId);
		// 未飲・気になるは「飲んだ本数」に数えない
		expect(summary.tastedCount).toBe(2);
		expect(summary.totalCount).toBe(4);
		expect(summary.latest?.name).toBe("気になる");
	});

	it("1件も無ければ 0", async () => {
		const userId = await freshUser();
		const summary = await getCellarSummary(userId);
		expect(summary.tastedCount).toBe(0);
		expect(summary.totalCount).toBe(0);
		expect(summary.latest).toBeNull();
	});
});

describe("既存データのバックフィル", () => {
	it("旧スキーマ相当の行(飲用記録なし)を移送すると集計が復旧する", async () => {
		const userId = await freshUser();
		// マイグレーション前の行を模す: status/集計列は DEFAULT のまま、旧列だけ持つ
		const id = crypto.randomUUID();
		await db.insert(drunkWine).values({
			id,
			userId,
			name: "旧データ",
			drankOn: "2019-09-09",
			rating: 4,
			memo: "移送前",
		});
		expect((await wineRow(id))?.tastingCount).toBe(0);

		// マイグレーションの INSERT ... SELECT + 再計算 UPDATE と同じ効果
		await db.insert(wineTasting).values({
			id: `legacy-${id}`,
			drunkWineId: id,
			userId,
			drankOn: "2019-09-09",
			rating: 4,
			memo: "移送前",
		});
		await updateLatestWineTasting(userId, id, {});

		const row = await wineRow(id);
		expect(row?.tastingCount).toBe(1);
		expect(row?.lastDrankOn).toBe("2019-09-09");
		expect(row?.status).toBe("finished");
	});
});
