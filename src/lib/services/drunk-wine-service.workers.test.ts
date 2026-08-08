import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { drunkWine, importBatch, wineSighting, wineTasting } from "#/db/schema";
import {
	CELLAR_FILTER_IDS,
	countCellarFilters as countCellarFiltersPure,
	matchesCellarFilter,
} from "#/lib/drunk-wine/filter";
import { thumbKeyForPhotoKey } from "#/lib/drunk-wine/photo";
import type { WineStatus } from "#/lib/drunk-wine/status";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { imageKeyFromPath } from "#/lib/images/signed-url";
import type { BulkRegisterFromScanInput } from "#/lib/import-batch/schema";
import {
	addWineSighting,
	addWineTasting,
	bulkRegisterFromScan,
	countCellarFilters,
	createDrunkWine,
	deleteDrunkWine,
	deleteDrunkWines,
	deleteWineSighting,
	deleteWineTasting,
	getCellarSummary,
	getDrunkWine,
	getImportBatch,
	listDrunkWines,
	listDrunkWinesByAop,
	listImportBatches,
	listWineSightings,
	listWineTastings,
	markWineDrunk,
	saveImportBatchPhotos,
	syncDrunkWinePhotos,
	undoImportBatch,
	updateDrunkWine,
	updateLatestWineTasting,
	updateWineSighting,
	updateWineTasting,
} from "./drunk-wine-service";
import { createPlace, deletePlace, listPlaces } from "./place-service";

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

/**
 * まとめ削除の件数境界(#400)用に、最小列だけの銘柄をまとめて作る。サービス層を
 * 通すと1件ごとに複数文を投げるので、境界の100件超では遅すぎる。
 * 種まき側の INSERT も同じ D1 のバインド変数上限に縛られるため小分けにする
 * (drizzle が既定値も束縛するので1行6個 → 15行で90個)。
 */
async function seedEntries(userId: string, count: number): Promise<string[]> {
	const ids = Array.from({ length: count }, (_, i) => `${userId}-bulk-${i}`);
	for (let i = 0; i < ids.length; i += 15) {
		await db
			.insert(drunkWine)
			.values(ids.slice(i, i + 15).map((id) => ({ id, userId, name: id })));
	}
	return ids;
}

async function countEntries(userId: string): Promise<number> {
	const rows = await db
		.select({ id: drunkWine.id })
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId));
	return rows.length;
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
		expect(entry.lastRating).toBe(5);
		expect(entry.lastMemo).toBe("好み");
	});
});

// 銘柄のコメント(#471)。飲用記録の memo とは別の列で、飲む前のエントリにも付く。
describe("銘柄のコメント(note)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("作成時に保存され、読み取りで返る", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Chablis",
			status: "spotted",
			note: "【香り・味わい】\n柑橘と火打石。",
		});
		expect(entry.note).toBe("【香り・味わい】\n柑橘と火打石。");
		expect((await getDrunkWine(userId, entry.id)).note).toBe(entry.note);
		// 飲用記録は作らない = 銘柄のコメントは飲用の有無と独立している
		expect(entry.tastingCount).toBe(0);
	});

	it("未指定なら null。更新で書き換え、null でクリアできる", async () => {
		const entry = await createDrunkWine(userId, {
			name: "Meursault",
			status: "owned",
		});
		expect(entry.note).toBeNull();

		const written = await updateDrunkWine(userId, {
			id: entry.id,
			note: "ナッツと蜂蜜。",
		});
		expect(written.note).toBe("ナッツと蜂蜜。");

		const cleared = await updateDrunkWine(userId, { id: entry.id, note: null });
		expect(cleared.note).toBeNull();
	});

	it("一括登録で作った銘柄にもコメントが載る", async () => {
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: {
						name: "Barolo",
						note: "【生産者】\n家族経営のカンティーナ。",
					},
				},
			],
		});
		expect(result.createdCount).toBe(1);
		const { entries } = await listDrunkWines(userId);
		expect(entries[0]?.note).toBe("【生産者】\n家族経営のカンティーナ。");
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

	it("評価・メモは最新1件を読み取り時に導出する(列には持たない)", async () => {
		await addWineTasting(userId, wineId, {
			drankOn: "2022-06-01",
			rating: 2,
			memo: "古い",
		});
		const entry = await addWineTasting(userId, wineId, {
			drankOn: "2024-01-01",
			rating: 5,
			memo: "新しい",
		});
		expect(entry.lastDrankOn).toBe("2024-01-01");
		expect(entry.lastRating).toBe(5);
		expect(entry.lastMemo).toBe("新しい");

		// 一覧・単体取得(SELECT 経路)でも同じ値になること。相関サブクエリは
		// UPDATE と SELECT で描画のされ方が違い、修飾を誤ると静かに null になる。
		const listed = (await listDrunkWines(userId)).entries.find(
			(e) => e.id === wineId,
		);
		expect(listed?.lastRating).toBe(5);
		expect(listed?.lastMemo).toBe("新しい");
		const fetched = await getDrunkWine(userId, wineId);
		expect(fetched.lastRating).toBe(5);
		expect(fetched.lastMemo).toBe("新しい");
	});

	it("同じ日の2件では created_at の新しい方が最新になる", async () => {
		await addWineTasting(userId, wineId, { drankOn: "2024-01-01", memo: "先" });
		const entry = await addWineTasting(userId, wineId, {
			drankOn: "2024-01-01",
			memo: "後",
		});
		expect(entry.lastMemo).toBe("後");
		expect((await getDrunkWine(userId, wineId)).lastMemo).toBe("後");
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

// ---- deleteDrunkWines(まとめ削除, Issue #363 案B) --------------------------

describe("deleteDrunkWines", () => {
	it("選んだ複数エントリをまとめて削除し、子テーブルもcascadeで消える", async () => {
		const userId = await freshUser();
		const a = await createDrunkWine(userId, {
			name: "A",
			tasting: { drankOn: "2020-01-01" },
		});
		const b = await createDrunkWine(userId, { name: "B" });
		const keep = await createDrunkWine(userId, { name: "残す" });

		const result = await deleteDrunkWines(userId, [a.id, b.id]);
		expect(result.deletedCount).toBe(2);
		expect(await wineRow(a.id)).toBeUndefined();
		expect(await wineRow(b.id)).toBeUndefined();
		expect(await wineRow(keep.id)).toBeDefined();
		expect(await tastingRows(a.id)).toHaveLength(0);
	});

	it("他ユーザのidが混ざっていても自分のエントリだけ消え、件数もそれに一致する", async () => {
		const owner = await freshUser();
		const other = await freshUser();
		const mine = await createDrunkWine(owner, { name: "自分の" });
		const theirs = await createDrunkWine(other, { name: "他人の" });

		const result = await deleteDrunkWines(owner, [mine.id, theirs.id]);
		expect(result.deletedCount).toBe(1);
		expect(await wineRow(mine.id)).toBeUndefined();
		expect(await wineRow(theirs.id)).toBeDefined();
	});

	it("空配列を渡すと何も削除せず0件を返す", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "無傷" });
		const result = await deleteDrunkWines(userId, []);
		expect(result.deletedCount).toBe(0);
		expect(await wineRow(entry.id)).toBeDefined();
	});

	// Issue #400: 「すべて選択」は読み込み済みの全件を選ぶので、100件を超える選択も
	// 100件ちょうども実際に起きる。後者は id 100個 + userId で 101 バインド変数となり、
	// 分割しないと D1 の「1クエリ100個」上限でクエリ自体が失敗する。
	describe("大量の id(#400)", () => {
		it("100件ちょうどでも D1 のバインド変数上限に触れず全件消える", async () => {
			const userId = await freshUser();
			const ids = await seedEntries(userId, 100);

			const result = await deleteDrunkWines(userId, ids);

			expect(result.deletedCount).toBe(100);
			expect(await countEntries(userId)).toBe(0);
		});

		it("101件・120件のように1文に収まらない選択でも分割して全件消える", async () => {
			for (const n of [101, 120]) {
				const userId = await freshUser();
				const ids = await seedEntries(userId, n);

				const result = await deleteDrunkWines(userId, ids);

				expect(result.deletedCount).toBe(n);
				expect(await countEntries(userId)).toBe(0);
			}
		});

		it("分割をまたいでも他ユーザのエントリには触れない", async () => {
			const owner = await freshUser();
			const other = await freshUser();
			const mine = await seedEntries(owner, 110);
			const theirs = await seedEntries(other, 10);

			// 自分の110件の途中に他人のidを混ぜる(チャンク境界の内側と外側の両方)
			const result = await deleteDrunkWines(owner, [
				...mine.slice(0, 40),
				...theirs,
				...mine.slice(40),
			]);

			expect(result.deletedCount).toBe(110);
			expect(await countEntries(owner)).toBe(0);
			expect(await countEntries(other)).toBe(10);
		});
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

describe("集計キャッシュの復旧", () => {
	it("飲用記録を後から入れて再計算すると集計が復旧する", async () => {
		// drizzle/0018 のバックフィル(INSERT ... SELECT + 再計算 UPDATE)と同じ形。
		// 旧列(drank_on/rating/memo)は 0019 で削除済みなので、移送元ではなく
		// 「集計が 0 の行に飲用記録を足して打ち直す」復旧手順として固定する。
		const userId = await freshUser();
		const id = crypto.randomUUID();
		await db.insert(drunkWine).values({ id, userId, name: "集計が崩れた行" });
		expect((await wineRow(id))?.tastingCount).toBe(0);

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

// ---- 一覧のページネーションと絞り込み (#254) --------------------------------
// マイセラーはユーザが単調に増やすデータで上限が無い。全件取得のままだと行スキャン・
// レスポンスサイズ・MCP のトークン消費が件数に線形で悪化する。ページ境界と、
// SQL 側の絞り込みが純関数の述語(matchesCellarFilter)と一致することを実データで固定する。

describe("listDrunkWines のページネーション", () => {
	/** created_at を明示して n 件作る(カーソルの並び順を決定的にする)。 */
	async function seedEntries(
		userId: string,
		specs: { name: string; status?: WineStatus; createdAt: number }[],
	) {
		for (const spec of specs) {
			const entry = await createDrunkWine(userId, {
				name: spec.name,
				status: spec.status,
			});
			await db
				.update(drunkWine)
				.set({ createdAt: new Date(spec.createdAt) })
				.where(eq(drunkWine.id, entry.id));
		}
	}

	it("limit 未指定なら全件返す(地図はページ単位にできない)", async () => {
		const userId = await freshUser();
		await seedEntries(userId, [
			{ name: "a", createdAt: 1000 },
			{ name: "b", createdAt: 2000 },
			{ name: "c", createdAt: 3000 },
		]);
		const page = await listDrunkWines(userId);
		expect(page.entries).toHaveLength(3);
		expect(page.nextCursor).toBeNull();
	});

	it("カーソルで続きを取ると、重複も取りこぼしもなく全件を辿れる", async () => {
		const userId = await freshUser();
		const specs = Array.from({ length: 7 }, (_, i) => ({
			name: `w${i}`,
			createdAt: 1000 + i,
		}));
		await seedEntries(userId, specs);

		const seen: string[] = [];
		let cursor: string | null | undefined;
		for (let i = 0; i < 10; i++) {
			const page = await listDrunkWines(userId, { limit: 3, cursor });
			seen.push(...page.entries.map((e) => e.name));
			cursor = page.nextCursor;
			if (!cursor) break;
		}
		// 新しい順(createdAt 降順)で7件、重複なし
		expect(seen).toEqual(["w6", "w5", "w4", "w3", "w2", "w1", "w0"]);
		expect(new Set(seen).size).toBe(7);
	});

	it("created_at が同一でも行が飛ばない(id をタイブレーカにする)", async () => {
		const userId = await freshUser();
		await seedEntries(userId, [
			{ name: "same-1", createdAt: 5000 },
			{ name: "same-2", createdAt: 5000 },
			{ name: "same-3", createdAt: 5000 },
		]);
		const first = await listDrunkWines(userId, { limit: 2 });
		expect(first.entries).toHaveLength(2);
		const second = await listDrunkWines(userId, {
			limit: 2,
			cursor: first.nextCursor,
		});
		const names = [...first.entries, ...second.entries].map((e) => e.name);
		expect(new Set(names).size).toBe(3);
	});

	it("最終ページでは nextCursor が null になる", async () => {
		const userId = await freshUser();
		await seedEntries(userId, [
			{ name: "a", createdAt: 1000 },
			{ name: "b", createdAt: 2000 },
		]);
		const page = await listDrunkWines(userId, { limit: 2 });
		expect(page.entries).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	it("limit は上限で頭打ちにする(MCP から巨大な値を渡されても効く)", async () => {
		const userId = await freshUser();
		await seedEntries(userId, [{ name: "a", createdAt: 1000 }]);
		const page = await listDrunkWines(userId, { limit: 10_000 });
		expect(page.entries).toHaveLength(1);
	});

	it("他人のエントリは混ざらない", async () => {
		const mine = await freshUser();
		const other = await freshUser();
		await seedEntries(mine, [{ name: "mine", createdAt: 1000 }]);
		await seedEntries(other, [{ name: "other", createdAt: 2000 }]);
		const page = await listDrunkWines(mine, { limit: 10 });
		expect(page.entries.map((e) => e.name)).toEqual(["mine"]);
	});

	it("SQL側の絞り込みが純関数の述語と一致する", async () => {
		// 一覧チップの定義(matchesCellarFilter)を SQL に写しているので、両者が
		// ズレると「チップの件数と中身が食い違う」形で壊れる。実データで突合する。
		const userId = await freshUser();
		const specs: { name: string; status: WineStatus; createdAt: number }[] = [
			{ name: "wishlist-untasted", status: "wishlist", createdAt: 1000 },
			{ name: "owned-untasted", status: "owned", createdAt: 2000 },
			{ name: "finished-untasted", status: "finished", createdAt: 3000 },
			{ name: "owned-tasted", status: "owned", createdAt: 4000 },
			{ name: "finished-tasted", status: "finished", createdAt: 5000 },
		];
		await seedEntries(userId, specs);
		for (const name of ["owned-tasted", "finished-tasted"]) {
			const all = await listDrunkWines(userId);
			const target = all.entries.find((e) => e.name === name);
			if (target) await addWineTasting(userId, target.id, { rating: 4 });
		}

		const all = (await listDrunkWines(userId)).entries;
		for (const filter of CELLAR_FILTER_IDS) {
			const bySql = (await listDrunkWines(userId, { filter })).entries
				.map((e) => e.name)
				.sort();
			const byPredicate = all
				.filter((e) => matchesCellarFilter(e, filter))
				.map((e) => e.name)
				.sort();
			expect(bySql, `filter=${filter}`).toEqual(byPredicate);
		}
	});

	it("countCellarFilters が純関数の集計と一致する", async () => {
		const userId = await freshUser();
		await seedEntries(userId, [
			{ name: "wishlist", status: "wishlist", createdAt: 1000 },
			{ name: "owned", status: "owned", createdAt: 2000 },
			{ name: "finished", status: "finished", createdAt: 3000 },
		]);
		const all = (await listDrunkWines(userId)).entries;
		const target = all.find((e) => e.name === "owned");
		if (target) await addWineTasting(userId, target.id, { rating: 3 });

		const fromSql = await countCellarFilters(userId);
		const fromEntries = countCellarFiltersPure(
			(await listDrunkWines(userId)).entries,
		);
		expect(fromSql).toEqual(fromEntries);
	});
});

// ---- 情報パネルのマイセラー欄 ---------------------------------------------
// 地図の情報パネルは「表示中のAOPを紐付けた自分の登録」だけを出す。スコープが
// 「aop_id の完全一致 かつ 自分の行」であることをここで固定する(階層のロールアップ
// も他ユーザの行の混入もしない)。

describe("listDrunkWinesByAop", () => {
	it("そのAOPを紐付けた自分の登録だけを新しい順に返す", async () => {
		const userId = await freshUser();
		const gevrey = await createDrunkWine(userId, {
			name: "ジュヴレ 2019",
			aopId: "gevrey-chambertin",
		});
		const gevrey2 = await createDrunkWine(userId, {
			name: "ジュヴレ 2020",
			aopId: "gevrey-chambertin",
		});
		// 別AOP・AOP未紐付けは対象外
		await createDrunkWine(userId, { name: "ブルイィ", aopId: "brouilly" });
		await createDrunkWine(userId, { name: "紐付けなし" });
		// 並びを決定的にする(createdAt 降順)
		await db
			.update(drunkWine)
			.set({ createdAt: new Date(1000) })
			.where(eq(drunkWine.id, gevrey.id));
		await db
			.update(drunkWine)
			.set({ createdAt: new Date(2000) })
			.where(eq(drunkWine.id, gevrey2.id));

		const entries = await listDrunkWinesByAop(userId, "gevrey-chambertin");
		expect(entries.map((e) => e.name)).toEqual([
			"ジュヴレ 2020",
			"ジュヴレ 2019",
		]);
	});

	it("畑に紐付けたワインを親の村名AOCには出さない", async () => {
		const userId = await freshUser();
		await createDrunkWine(userId, {
			name: "シャンベルタン",
			aopId: "chambertin",
		});
		expect(await listDrunkWinesByAop(userId, "gevrey-chambertin")).toEqual([]);
		expect(
			(await listDrunkWinesByAop(userId, "chambertin")).map((e) => e.name),
		).toEqual(["シャンベルタン"]);
	});

	it("他ユーザの登録は見えない", async () => {
		const mine = await freshUser();
		const other = await freshUser();
		await createDrunkWine(other, {
			name: "他人のワイン",
			aopId: "gevrey-chambertin",
		});
		expect(await listDrunkWinesByAop(mine, "gevrey-chambertin")).toEqual([]);
	});

	it("最新の飲用記録の評価を載せる(一覧と同じ導出)", async () => {
		const userId = await freshUser();
		// owned で作る(finished は飲用記録を自動で1件作るため件数が読みにくい)
		const entry = await createDrunkWine(userId, {
			name: "評価あり",
			status: "owned",
			aopId: "gevrey-chambertin",
		});
		await addWineTasting(userId, entry.id, {
			drankOn: "2026-01-01",
			rating: 3,
		});
		await addWineTasting(userId, entry.id, {
			drankOn: "2026-02-01",
			rating: 5,
		});

		const [row] = await listDrunkWinesByAop(userId, "gevrey-chambertin");
		expect(row?.lastRating).toBe(5);
		expect(row?.lastDrankOn).toBe("2026-02-01");
		expect(row?.tastingCount).toBe(2);
	});

	// #333: aops.json から ID を消す・改名すると、それ以前に登録された行は FK が無いため
	// 静かに孤児化する(AOP名と地域が消え、セラー地図からも落ちて「未紐付け」に合算される)。
	// 退役IDに後継を登録してあれば、既存行は後継AOPのものとして生き続ける。
	it("退役IDで保存された行も、後継AOPのワインとして扱う", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "ラ・ガフリエール 2015",
			aopId: "saint-emilion-grand-cru",
		});
		// マスタから消える前(#216 以前)に登録された行を再現する
		await db
			.update(drunkWine)
			.set({ aopId: "chateau-la-gaffeliere" })
			.where(eq(drunkWine.id, entry.id));

		// 後継AOPのパネルに出る(旧IDのまま完全一致で引くと落ちてしまう)
		const entries = await listDrunkWinesByAop(
			userId,
			"saint-emilion-grand-cru",
		);
		expect(entries.map((e) => e.name)).toContain("ラ・ガフリエール 2015");

		// 表示・地図に必要な導出値も埋まる(AOP名・地域が null に落ちない)
		const found = await getDrunkWine(userId, entry.id);
		expect(found.aopId).toBe("saint-emilion-grand-cru");
		expect(found.aopNameJa).not.toBeNull();
		expect(found.regionId).toBe("bordeaux");
	});

	it("退役IDで登録しようとしても、保存されるのは後継のID", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "旧IDで登録",
			aopId: "chateau-la-gaffeliere",
		});
		expect((await wineRow(entry.id))?.aopId).toBe("saint-emilion-grand-cru");
	});
});

// ---- 産地の粗い紐付け(地域・国) --------------------------------------------
// 「最も細かい1つだけを保存する」排他と、読み取り時の細→粗の導出を実D1で固定する。

describe("産地の粗い紐付け(region_id / country_id)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("地域単位で保存でき、国は導出される", async () => {
		const entry = await createDrunkWine(userId, {
			name: "村不明のブルゴーニュ",
			regionId: "bourgogne",
		});
		expect(entry.aopId).toBeNull();
		expect(entry.regionId).toBe("bourgogne");
		expect(entry.countryId).toBe("france");
		const row = await wineRow(entry.id);
		expect(row?.regionId).toBe("bourgogne");
		expect(row?.countryId).toBeNull(); // 導出できる粗い列は保存しない
	});

	it("国単位で保存できる", async () => {
		const entry = await createDrunkWine(userId, {
			name: "地域不明のイタリア",
			countryId: "italy",
		});
		expect(entry.regionId).toBeNull();
		expect(entry.countryId).toBe("italy");
		expect((await wineRow(entry.id))?.countryId).toBe("italy");
	});

	it("AOP指定時は地域・国を渡しても保存されない(最も細かい1つだけ)", async () => {
		const entry = await createDrunkWine(userId, {
			name: "シャブリ",
			aopId: "chablis",
			regionId: "bordeaux", // 矛盾した入力はAOP優先で無視される
			countryId: "italy",
		});
		expect(entry.regionId).toBe("bourgogne"); // AOPから導出
		expect(entry.countryId).toBe("france");
		const row = await wineRow(entry.id);
		expect(row?.aopId).toBe("chablis");
		expect(row?.regionId).toBeNull();
		expect(row?.countryId).toBeNull();
	});

	it("更新でAOP→地域へ粒度を切り替えると aop_id がクリアされる", async () => {
		const entry = await createDrunkWine(userId, {
			name: "紐付け直し",
			aopId: "chablis",
		});
		const updated = await updateDrunkWine(userId, {
			id: entry.id,
			regionId: "bourgogne",
		});
		expect(updated.aopId).toBeNull();
		expect(updated.regionId).toBe("bourgogne");
		const row = await wineRow(entry.id);
		expect(row?.aopId).toBeNull();
		expect(row?.regionId).toBe("bourgogne");
	});

	it("更新で地域→AOPへ粒度を切り替えると region_id がクリアされる", async () => {
		const entry = await createDrunkWine(userId, {
			name: "特定できた",
			regionId: "bourgogne",
		});
		const updated = await updateDrunkWine(userId, {
			id: entry.id,
			aopId: "gevrey-chambertin",
		});
		expect(updated.aopId).toBe("gevrey-chambertin");
		const row = await wineRow(entry.id);
		expect(row?.aopId).toBe("gevrey-chambertin");
		expect(row?.regionId).toBeNull();
	});

	it("更新で国→地域へ、地域のクリアだけも送れる", async () => {
		const entry = await createDrunkWine(userId, {
			name: "国から地域へ",
			countryId: "france",
		});
		const regionLinked = await updateDrunkWine(userId, {
			id: entry.id,
			regionId: "loire",
		});
		expect(regionLinked.regionId).toBe("loire");
		expect((await wineRow(entry.id))?.countryId).toBeNull();

		// 紐付け解除(null クリア)
		const cleared = await updateDrunkWine(userId, {
			id: entry.id,
			regionId: null,
		});
		expect(cleared.regionId).toBeNull();
		expect(cleared.countryId).toBeNull();
	});

	it("未知の地域・国は BadRequest", async () => {
		await expect(
			createDrunkWine(userId, { name: "x", regionId: "no-such-region" }),
		).rejects.toBeInstanceOf(BadRequestError);
		await expect(
			createDrunkWine(userId, { name: "x", countryId: "spain" }),
		).rejects.toBeInstanceOf(BadRequestError);
	});

	it("一括登録でも地域単位の紐付けが保存される", async () => {
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "地域だけ判明", regionId: "toscana" } }],
		} as BulkRegisterFromScanInput);
		expect(result.createdCount).toBe(1);
		const { entries } = await listDrunkWines(userId);
		const found = entries.find((e) => e.name === "地域だけ判明");
		expect(found?.regionId).toBe("toscana");
		expect(found?.countryId).toBe("italy");
		expect(found?.aopId).toBeNull();
	});
});

// ---- 一覧用サムネイル (#237) -----------------------------------------------
// 一覧グリッドは150〜200px表示なのに原寸(最大5MB)を読んでいた。保存時に縮小版を
// 並べて置き、キーは原寸から導出する。DBに列を足していないので、「サムネイルが
// 実在するか」はR2の中身がすべて。put/delete の追随をここで固定する。

describe("写真サムネイルの保存と削除", () => {
	// 1x1 JPEG(マジックバイト検証を通る最小の実データ)
	const JPEG_1X1 = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	async function objectExists(key: string): Promise<boolean> {
		return (await env.AVATARS.head(key)) !== null;
	}

	it("新規写真と一緒にサムネイルを保存する", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "写真つき" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{
				kind: "new",
				bytes: JPEG_1X1,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1,
			},
		]);

		expect(saved.photoUrls).toHaveLength(1);
		// 一覧が読むURLは原寸ではなくサムネイル
		expect(saved.thumbUrls[0]).toBe(`${saved.photoUrls[0]}.thumb.jpg`);
		const photoKey = imageKeyFromPath(saved.photoUrls[0] as string);
		expect(await objectExists(photoKey)).toBe(true);
		expect(await objectExists(thumbKeyForPhotoKey(photoKey))).toBe(true);
	});

	it("サムネイルを送らなくても保存できる(MCP 経由など)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "サムネなし" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);
		const photoKey = imageKeyFromPath(saved.photoUrls[0] as string);
		expect(await objectExists(photoKey)).toBe(true);
		// 実体は無いが、URLは常に導出できる(配信ルートが原寸へフォールバックする)
		expect(await objectExists(thumbKeyForPhotoKey(photoKey))).toBe(false);
		expect(saved.thumbUrls).toHaveLength(1);
	});

	it("写真を外すとサムネイルも消える(R2に孤児を残さない)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "差し替え" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{
				kind: "new",
				bytes: JPEG_1X1,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1,
			},
		]);
		const photoKey = imageKeyFromPath(saved.photoUrls[0] as string);

		await syncDrunkWinePhotos(userId, entry.id, []);
		expect(await objectExists(photoKey)).toBe(false);
		expect(await objectExists(thumbKeyForPhotoKey(photoKey))).toBe(false);
	});

	it("エントリを削除するとサムネイルも消える", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "削除" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{
				kind: "new",
				bytes: JPEG_1X1,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1,
			},
		]);
		const photoKey = imageKeyFromPath(saved.photoUrls[0] as string);

		await deleteDrunkWine(userId, entry.id);
		expect(await objectExists(photoKey)).toBe(false);
		expect(await objectExists(thumbKeyForPhotoKey(photoKey))).toBe(false);
	});

	it("まとめ削除(deleteDrunkWines)でも複数エントリの写真とサムネイルが全て消える", async () => {
		const userId = await freshUser();
		const a = await createDrunkWine(userId, { name: "まとめ削除A" });
		const b = await createDrunkWine(userId, { name: "まとめ削除B" });
		const savedA = await syncDrunkWinePhotos(userId, a.id, [
			{
				kind: "new",
				bytes: JPEG_1X1,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1,
			},
		]);
		const savedB = await syncDrunkWinePhotos(userId, b.id, [
			{
				kind: "new",
				bytes: JPEG_1X1,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1,
			},
		]);
		const keyA = imageKeyFromPath(savedA.photoUrls[0] as string);
		const keyB = imageKeyFromPath(savedB.photoUrls[0] as string);

		await deleteDrunkWines(userId, [a.id, b.id]);
		for (const key of [keyA, keyB]) {
			expect(await objectExists(key)).toBe(false);
			expect(await objectExists(thumbKeyForPhotoKey(key))).toBe(false);
		}
	});

	it("画像として認識できないサムネイルは保存しない(原寸は保存する)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "壊れたサムネ" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{
				kind: "new",
				bytes: JPEG_1X1,
				mimeType: "image/jpeg",
				thumbBytes: new TextEncoder().encode("<html>not an image</html>"),
			},
		]);
		const photoKey = imageKeyFromPath(saved.photoUrls[0] as string);
		expect(await objectExists(photoKey)).toBe(true);
		expect(await objectExists(thumbKeyForPhotoKey(photoKey))).toBe(false);
	});
});

// R2 の後始末(巻き戻し・孤児掃除)が失敗しても、呼び出し元の結果を左右してはいけない(#249)。
// 巻き戻しの delete をそのまま投げると元例外を置き換えてしまい、画像偽装拒否の
// BadRequestError(400) が R2 障害で 500 に化けて真因がログからも消える。
describe("写真のR2後始末が失敗したときの扱い (#249)", () => {
	// 1x1 JPEG(マジックバイト検証を通る最小の実データ)
	const JPEG_1X1 = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);
	const NOT_AN_IMAGE = new TextEncoder().encode("<html>not an image</html>");

	let logs: string[] = [];
	beforeEach(() => {
		logs = [];
		vi.spyOn(console, "error").mockImplementation((line: unknown) => {
			logs.push(String(line));
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** 直近の delete 呼び出しだけを失敗させる */
	function failNextDelete(): void {
		vi.spyOn(env.AVATARS, "delete").mockRejectedValueOnce(
			new Error("R2 unavailable"),
		);
	}

	it("巻き戻しが失敗しても元の例外(400)がそのまま伝わる", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "巻き戻し" });
		failNextDelete();

		// 1枚目は put 成功 → 2枚目が画像偽装で拒否 → 巻き戻し(delete)が失敗する
		await expect(
			syncDrunkWinePhotos(userId, entry.id, [
				{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
				{ kind: "new", bytes: NOT_AN_IMAGE, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow(BadRequestError);

		// R2 の "R2 unavailable" ではなく、検証拒否の理由が伝わっていること
		await expect(
			syncDrunkWinePhotos(userId, entry.id, [
				{ kind: "new", bytes: NOT_AN_IMAGE, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow(/画像として認識できない/);
	});

	it("巻き戻しの失敗は構造化ログに残る(真因も一緒に記録する)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "巻き戻しログ" });
		failNextDelete();

		await expect(
			syncDrunkWinePhotos(userId, entry.id, [
				{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
				{ kind: "new", bytes: NOT_AN_IMAGE, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow(BadRequestError);

		const line = logs.find((l) => l.includes("photo cleanup failed"));
		expect(line).toBeDefined();
		const parsed = JSON.parse(line as string);
		expect(parsed.level).toBe("error");
		expect(parsed.userId).toBe(userId);
		expect(parsed.entryId).toBe(entry.id);
		expect(parsed.phase).toBe("rollback");
		expect(parsed.err).toContain("R2 unavailable");
		// 掃除失敗のログだけが残って真因が消えると、put 失敗か検証拒否かを追えない
		expect(parsed.originalErr).toContain("画像として認識できない");
	});

	it("孤児掃除が失敗しても、確定済みの写真更新は成功として返す", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "孤児掃除" });
		const saved = await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);
		expect(saved.photoUrls).toHaveLength(1);

		failNextDelete();
		// D1 は既に更新済み。ここで throw すると「成功した更新が失敗として返る」
		const cleared = await syncDrunkWinePhotos(userId, entry.id, []);
		expect(cleared.photoUrls).toHaveLength(0);
		expect(await getDrunkWine(userId, entry.id)).toMatchObject({
			photoUrls: [],
		});
		expect(logs.some((l) => l.includes("photo cleanup failed"))).toBe(true);
	});

	it("エントリ削除時のR2掃除が失敗しても削除は成功として返す", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "削除時掃除" });
		await syncDrunkWinePhotos(userId, entry.id, [
			{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);

		failNextDelete();
		await expect(deleteDrunkWine(userId, entry.id)).resolves.toBeUndefined();
		await expect(getDrunkWine(userId, entry.id)).rejects.toThrow();
		expect(logs.some((l) => l.includes("photo cleanup failed"))).toBe(true);
	});
});

// ---- 目撃記録(第3の 1:N 軸。Issue #358) ----------------------------------
// 集計キャッシュを1つの UPDATE で4列まとめて再計算する形にしたので、
// 「飲用側だけを触ったつもりが目撃側を壊す(逆も)」が最大の回帰リスク。
// MAX の巻き戻り・NULL 混在という飲用側と同じ落とし穴も、目撃側で独立に固定する。

describe("目撃記録の集計キャッシュ", () => {
	let userId: string;
	let wineId: string;
	beforeEach(async () => {
		userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "Chablis",
			status: "spotted",
		});
		wineId = entry.id;
	});

	it("見かけただけの登録は目撃0件・飲用0件から始まる", async () => {
		const entry = await getDrunkWine(userId, wineId);
		expect(entry.status).toBe("spotted");
		expect(entry.sightingCount).toBe(0);
		expect(entry.lastSeenOn).toBeNull();
		// finished の「日付なし飲用記録を1件作る」規則に巻き込まれない
		expect(entry.tastingCount).toBe(0);
	});

	it("複数追加すると件数が増え、last_seen_on は挿入順でなく MAX になる", async () => {
		await addWineSighting(userId, wineId, { seenOn: "2022-06-01" });
		await addWineSighting(userId, wineId, { seenOn: "2024-01-01" });
		const entry = await addWineSighting(userId, wineId, {
			seenOn: "2023-03-03",
		});
		expect(entry.sightingCount).toBe(3);
		expect(entry.lastSeenOn).toBe("2024-01-01");
	});

	it("最新を削除すると last_seen_on が次に大きい値へ戻る", async () => {
		await addWineSighting(userId, wineId, { seenOn: "2022-06-01" });
		const latest = await addWineSighting(userId, wineId, {
			seenOn: "2024-01-01",
		});
		expect(latest.lastSeenOn).toBe("2024-01-01");

		const sightings = await listWineSightings(userId, wineId);
		const newest = sightings.find((s) => s.seenOn === "2024-01-01");
		// 減算では表現できない挙動。全再計算にしている理由
		const after = await deleteWineSighting(userId, newest?.id ?? "");
		expect(after.sightingCount).toBe(1);
		expect(after.lastSeenOn).toBe("2022-06-01");
	});

	it("日付未入力の記録が混ざっても MAX が壊れない", async () => {
		await addWineSighting(userId, wineId, {});
		const entry = await addWineSighting(userId, wineId, {
			seenOn: "2023-08-08",
		});
		expect(entry.sightingCount).toBe(2);
		expect(entry.lastSeenOn).toBe("2023-08-08");
	});

	it("全件が日付未入力なら last_seen_on は null", async () => {
		await addWineSighting(userId, wineId, { memo: "棚の上段" });
		const entry = await addWineSighting(userId, wineId, { price: 4800 });
		expect(entry.sightingCount).toBe(2);
		expect(entry.lastSeenOn).toBeNull();
	});

	it("目撃記録の更新でも再計算される", async () => {
		await addWineSighting(userId, wineId, { seenOn: "2022-06-01" });
		const [sighting] = await listWineSightings(userId, wineId);
		const after = await updateWineSighting(userId, {
			id: sighting?.id ?? "",
			seenOn: "2025-05-05",
		});
		expect(after.lastSeenOn).toBe("2025-05-05");
		expect(after.sightingCount).toBe(1);
	});
});

describe("飲用記録と目撃記録の独立性", () => {
	let userId: string;
	let wineId: string;
	beforeEach(async () => {
		userId = await freshUser();
		const entry = await createDrunkWine(userId, {
			name: "Pommard",
			status: "owned",
		});
		wineId = entry.id;
	});

	it("目撃記録を足しても飲用側の集計が動かない", async () => {
		await addWineTasting(userId, wineId, { drankOn: "2023-03-03" });
		const before = await getDrunkWine(userId, wineId);

		const after = await addWineSighting(userId, wineId, {
			seenOn: "2025-01-01",
		});
		expect(after.tastingCount).toBe(before.tastingCount);
		expect(after.lastDrankOn).toBe(before.lastDrankOn);
		expect(after.sightingCount).toBe(1);
		expect(after.lastSeenOn).toBe("2025-01-01");
	});

	it("飲用記録を足しても目撃側の集計が動かない", async () => {
		await addWineSighting(userId, wineId, { seenOn: "2025-01-01" });
		const before = await getDrunkWine(userId, wineId);

		const after = await addWineTasting(userId, wineId, {
			drankOn: "2023-03-03",
		});
		expect(after.sightingCount).toBe(before.sightingCount);
		expect(after.lastSeenOn).toBe(before.lastSeenOn);
		expect(after.tastingCount).toBe(1);
		expect(after.lastDrankOn).toBe("2023-03-03");
	});

	it("飲用記録の削除で目撃側が巻き添えにならない", async () => {
		await addWineSighting(userId, wineId, { seenOn: "2025-01-01" });
		await addWineTasting(userId, wineId, { drankOn: "2023-03-03" });
		const [tasting] = await listWineTastings(userId, wineId);

		const after = await deleteWineTasting(userId, tasting?.id ?? "");
		expect(after.tastingCount).toBe(0);
		expect(after.lastDrankOn).toBeNull();
		expect(after.sightingCount).toBe(1);
		expect(after.lastSeenOn).toBe("2025-01-01");
	});

	it("同じワインを「見かけて、飲んで、また見かけた」が両軸で表現できる", async () => {
		await addWineSighting(userId, wineId, { seenOn: "2024-01-01" });
		await addWineTasting(userId, wineId, { drankOn: "2024-02-02", rating: 4 });
		const after = await addWineSighting(userId, wineId, {
			seenOn: "2025-03-03",
		});
		expect(after.sightingCount).toBe(2);
		expect(after.lastSeenOn).toBe("2025-03-03");
		expect(after.tastingCount).toBe(1);
		expect(after.lastDrankOn).toBe("2024-02-02");
		expect(after.lastRating).toBe(4);
	});
});

describe("目撃記録の並びと場所", () => {
	it("見かけた日の新しい順で、日付未入力は末尾に来る", async () => {
		const userId = await freshUser();
		const { id } = await createDrunkWine(userId, { name: "並び順" });
		await addWineSighting(userId, id, {});
		await addWineSighting(userId, id, { seenOn: "2022-01-01" });
		await addWineSighting(userId, id, { seenOn: "2024-12-31" });

		const rows = await listWineSightings(userId, id);
		expect(rows.map((r) => r.seenOn)).toEqual([
			"2024-12-31",
			"2022-01-01",
			null,
		]);
	});

	it("場所名を載せて返す", async () => {
		const userId = await freshUser();
		const { id } = await createDrunkWine(userId, { name: "場所つき" });
		const shop = await createPlace(userId, { name: "伊勢丹", kind: "shop" });
		await addWineSighting(userId, id, { placeId: shop.id });

		const [row] = await listWineSightings(userId, id);
		expect(row?.placeId).toBe(shop.id);
		expect(row?.placeName).toBe("伊勢丹");
	});

	it("場所を消しても目撃記録は残り、場所名だけが null になる", async () => {
		const userId = await freshUser();
		const { id } = await createDrunkWine(userId, { name: "場所削除" });
		const shop = await createPlace(userId, { name: "閉店した店" });
		await addWineSighting(userId, id, {
			placeId: shop.id,
			seenOn: "2024-05-05",
		});

		await deletePlace(userId, shop.id);

		const rows = await listWineSightings(userId, id);
		// set null であって cascade ではない(見かけた事実自体は失わせない)
		expect(rows).toHaveLength(1);
		expect(rows[0]?.placeId).toBeNull();
		expect(rows[0]?.placeName).toBeNull();
		expect(rows[0]?.seenOn).toBe("2024-05-05");
	});
});

describe("目撃記録の所有権", () => {
	it("他ユーザのエントリ・目撃記録への操作は Entry not found", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const { id } = await createDrunkWine(owner, { name: "他人のワイン" });
		await addWineSighting(owner, id, { seenOn: "2024-01-01" });
		const [sighting] = await listWineSightings(owner, id);

		await expect(listWineSightings(stranger, id)).rejects.toThrow(
			"Entry not found",
		);
		await expect(addWineSighting(stranger, id, {})).rejects.toThrow(
			"Entry not found",
		);
		await expect(
			updateWineSighting(stranger, { id: sighting?.id ?? "", price: 1 }),
		).rejects.toThrow("Entry not found");
		await expect(
			deleteWineSighting(stranger, sighting?.id ?? ""),
		).rejects.toThrow("Entry not found");
	});

	it("他ユーザの場所を指した目撃記録は作れない(FKは所有者を見ないため)", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const theirPlace = await createPlace(stranger, { name: "他人の行きつけ" });
		const { id } = await createDrunkWine(owner, { name: "参照先の所有権" });

		await expect(
			addWineSighting(owner, id, { placeId: theirPlace.id }),
		).rejects.toThrow("Place not found");

		// 更新経路でも同じガードが効く
		await addWineSighting(owner, id, {});
		const [sighting] = await listWineSightings(owner, id);
		await expect(
			updateWineSighting(owner, {
				id: sighting?.id ?? "",
				placeId: theirPlace.id,
			}),
		).rejects.toThrow("Place not found");
	});

	it("銘柄を削除すると目撃記録も消える(FK cascade)", async () => {
		const userId = await freshUser();
		const { id } = await createDrunkWine(userId, { name: "カスケード" });
		await addWineSighting(userId, id, { seenOn: "2024-01-01" });

		await deleteDrunkWine(userId, id);
		const rows = await db
			.select()
			.from(wineSighting)
			.where(eq(wineSighting.drunkWineId, id));
		expect(rows).toHaveLength(0);
	});
});

// 写真からの一括登録(Issue #358)。1回の db.batch で場所・バッチ・銘柄・目撃記録・
// 飲用記録・集計キャッシュを作る経路なので、見るのは「全部できているか」と
// 「失敗したときに中途半端な状態が残らないか」。
describe("bulkRegisterFromScan", () => {
	const item = (
		partial: Partial<BulkRegisterFromScanInput["items"][number]> = {},
	): BulkRegisterFromScanInput["items"][number] => ({
		wine: { name: "Chablis" },
		...partial,
	});

	it("銘柄・目撃記録・バッチをまとめて作り、集計キャッシュを更新する", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 2,
			items: [
				item({
					wine: { name: "Chablis Les Clos", vintage: 2020 },
					sighting: { photoIndex: 0, price: 24000 },
				}),
				item({ wine: { name: "Barolo Brunate" }, sighting: { photoIndex: 1 } }),
			],
		});

		expect(result).toMatchObject({
			createdCount: 2,
			matchedCount: 0,
			sightingCount: 2,
			tastingCount: 0,
			placeId: null,
		});

		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			// 見かけただけなので「飲んだ」記録は作られない(status も spotted)
			expect(entry.status).toBe("spotted");
			expect(entry.tastingCount).toBe(0);
			// 集計キャッシュが同じ batch で更新されている
			expect(entry.sightingCount).toBe(1);
			expect(entry.lastSeenOn).toBe("2026-08-01");
		}

		const sightings = await listWineSightings(
			userId,
			entries.find((e) => e.name === "Chablis Les Clos")?.id ?? "",
		);
		expect(sightings[0]).toMatchObject({
			batchId: result.batchId,
			photoIndex: 0,
			price: 24000,
			seenOn: "2026-08-01",
		});
	});

	it("既存エントリには銘柄を作らず目撃記録だけを足す", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
		});

		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [item({ wine: undefined, existingId: existing.id })],
		});

		expect(result).toMatchObject({ createdCount: 0, matchedCount: 1 });
		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		// 既存の状態(飲み終わった)は書き換えない。目撃記録が増えるだけ
		expect(entries[0]).toMatchObject({
			id: existing.id,
			status: "finished",
			sightingCount: 1,
			tastingCount: 1,
		});
	});

	it("「飲んだ」指定があれば飲用記録も同じ batch で作る", async () => {
		const userId = await freshUser();
		await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				item({
					wine: { name: "飲んだワイン", status: "finished" },
					tasting: { drankOn: "2026-07-31", rating: 4 },
				}),
			],
		});
		const { entries } = await listDrunkWines(userId);
		expect(entries[0]).toMatchObject({
			status: "finished",
			tastingCount: 1,
			lastDrankOn: "2026-07-31",
			lastRating: 4,
			sightingCount: 1,
		});
	});

	it("新規で場所を作ると、全ての目撃記録がその場所を指す", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			newPlace: { name: "ビストロ・クロード" },
			photoCount: 0,
			items: [item({ wine: { name: "A" } }), item({ wine: { name: "B" } })],
		});

		expect(result.placeId).not.toBeNull();
		const places = await listPlaces(userId);
		expect(places).toHaveLength(1);
		const { entries } = await listDrunkWines(userId);
		for (const entry of entries) {
			const [sighting] = await listWineSightings(userId, entry.id);
			expect(sighting?.placeId).toBe(result.placeId);
			expect(sighting?.placeName).toBe("ビストロ・クロード");
		}
	});

	it("他ユーザのエントリを指定した登録は丸ごと失敗する(部分適用しない)", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const theirs = await createDrunkWine(stranger, { name: "他人のワイン" });

		await expect(
			bulkRegisterFromScan(owner, {
				photoCount: 0,
				items: [
					item({ wine: { name: "巻き添えになってはいけない" } }),
					item({ wine: undefined, existingId: theirs.id }),
				],
			}),
		).rejects.toThrow("Entry not found");

		// 1件目も作られていない = 検証は全件そろってから
		expect((await listDrunkWines(owner)).entries).toHaveLength(0);
	});

	it("他ユーザの場所を指した登録は失敗する(FKは所有者を見ないため)", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const theirPlace = await createPlace(stranger, { name: "他人の行きつけ" });

		await expect(
			bulkRegisterFromScan(owner, {
				placeId: theirPlace.id,
				photoCount: 0,
				items: [item()],
			}),
		).rejects.toThrow("Place not found");
		expect((await listDrunkWines(owner)).entries).toHaveLength(0);
	});

	it("未知のAOPを含む登録は丸ごと失敗する", async () => {
		const userId = await freshUser();
		await expect(
			bulkRegisterFromScan(userId, {
				photoCount: 0,
				items: [
					item({ wine: { name: "正しい" } }),
					item({ wine: { name: "壊れている", aopId: "no-such-aop" } }),
				],
			}),
		).rejects.toBeInstanceOf(BadRequestError);
		expect((await listDrunkWines(userId)).entries).toHaveLength(0);
	});
});

// ---- undoImportBatch(バッチ単位の取り消し, Issue #363 案A) -----------------

describe("undoImportBatch", () => {
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	async function batchRow(id: string) {
		const [row] = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, id));
		return row;
	}

	it("新規作成したエントリだけを削除し、既存エントリは目撃記録だけ取り消して集計を再計算する", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
			tasting: { drankOn: "2020-01-01" },
		});

		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 0,
			items: [
				{ wine: { name: "新規のワイン" } },
				{ wine: undefined, existingId: existing.id },
			],
		});
		expect((await listDrunkWines(userId)).entries).toHaveLength(2);

		const undone = await undoImportBatch(userId, result.batchId);
		expect(undone.deletedCount).toBe(1);

		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		// 既存エントリは消えず、目撃記録だけ取り消されて集計が元に戻る
		expect(entries[0]).toMatchObject({
			id: existing.id,
			status: "finished",
			sightingCount: 0,
			lastSeenOn: null,
			// 飲用記録(バッチと無関係)はそのまま残る
			tastingCount: 1,
			lastDrankOn: "2020-01-01",
		});
		expect(await listWineSightings(userId, existing.id)).toHaveLength(0);
		expect(await batchRow(result.batchId)).toBeUndefined();
	});

	it("バッチが作った場所は削除しない", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			newPlace: { name: "取り消しても残る店" },
			photoCount: 0,
			items: [{ wine: { name: "取り消されるワイン" } }],
		});

		await undoImportBatch(userId, result.batchId);

		const places = await listPlaces(userId);
		expect(places.map((p) => p.name)).toContain("取り消しても残る店");
	});

	it("バッチ写真とエントリ写真をR2から削除する", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [{ wine: { name: "写真つき" }, sighting: { photoIndex: 0 } }],
		});
		const batch = await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);
		const batchPhotoKey = imageKeyFromPath(batch.photoUrls[0] as string);

		const { entries } = await listDrunkWines(userId);
		const entryId = entries[0]?.id as string;
		const savedEntryPhoto = await syncDrunkWinePhotos(userId, entryId, [
			{
				kind: "new",
				bytes: JPEG_1X1_BYTES,
				mimeType: "image/jpeg",
				thumbBytes: JPEG_1X1_BYTES,
			},
		]);
		const entryPhotoKey = imageKeyFromPath(
			savedEntryPhoto.photoUrls[0] as string,
		);

		await undoImportBatch(userId, result.batchId);

		expect(await env.AVATARS.head(batchPhotoKey)).toBeNull();
		expect(await env.AVATARS.head(entryPhotoKey)).toBeNull();
		expect(
			await env.AVATARS.head(thumbKeyForPhotoKey(entryPhotoKey)),
		).toBeNull();
	});

	it("他ユーザのバッチは取り消せない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const result = await bulkRegisterFromScan(owner, {
			photoCount: 0,
			items: [{ wine: { name: "他人のバッチ" } }],
		});

		await expect(
			undoImportBatch(stranger, result.batchId),
		).rejects.toBeInstanceOf(NotFoundError);
		expect((await listDrunkWines(owner)).entries).toHaveLength(1);
	});

	it("存在しないバッチIDは NotFoundError", async () => {
		const userId = await freshUser();
		await expect(
			undoImportBatch(userId, "no-such-batch"),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	// #393: 一括登録は既存エントリにも試飲記録を足せる(「このワインを飲んだ」)。
	// 取り消しがこれを消し残すと、ユーザには「取り消したのに飲んだ記録と評価が残る」
	// という無言のデータ不整合になる。**新規作成エントリぶんは FK cascade でたまたま
	// 消えていた**ため、既存エントリ経路だけがこの不具合の対象だった。
	it("既存エントリに足した試飲記録も取り消し、集計を元に戻す(#393)", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "finished",
			tasting: { drankOn: "2020-01-01", rating: 3 },
		});

		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 0,
			items: [
				// 既存エントリに「飲んだ」を付けて登録する
				{
					wine: undefined,
					existingId: existing.id,
					tasting: { drankOn: "2026-08-01", rating: 5 },
				},
			],
		});
		expect(result.tastingCount).toBe(1);
		// 取り消し前は2件(元からの1件 + バッチが足した1件)
		expect(await listWineTastings(userId, existing.id)).toHaveLength(2);

		await undoImportBatch(userId, result.batchId);

		// バッチが足した試飲記録だけが消え、手動で足した過去の記録は残る
		const tastings = await listWineTastings(userId, existing.id);
		expect(tastings).toHaveLength(1);
		expect(tastings[0]).toMatchObject({ drankOn: "2020-01-01", rating: 3 });

		// 集計も元に戻る(ここが戻らないと一覧・詳細に取り消し前の値が残り続ける)
		const { entries } = await listDrunkWines(userId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: existing.id,
			tastingCount: 1,
			lastDrankOn: "2020-01-01",
			lastRating: 3,
		});
	});

	// バッチ由来かどうかは wine_tasting.batch_id で判定する。取り消しが
	// 「そのエントリの試飲記録を全部消す」実装に退化したらここで落ちる。
	it("取り消し後に手動で足した試飲記録は巻き込まない(#393)", async () => {
		const userId = await freshUser();
		// status を明示して「日付なしの飲用記録を1件作る」既定(finished)を避ける。
		// ここで見たいのは batch 由来かどうかの選別だけなので、雑音を入れない。
		const existing = await createDrunkWine(userId, {
			name: "既存エントリ",
			status: "spotted",
		});

		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{
					wine: undefined,
					existingId: existing.id,
					tasting: { drankOn: "2026-08-01" },
				},
			],
		});
		// バッチとは無関係に、ユーザが自分で試飲記録を足す
		await addWineTasting(userId, existing.id, { drankOn: "2026-08-02" });

		await undoImportBatch(userId, result.batchId);

		const tastings = await listWineTastings(userId, existing.id);
		expect(tastings).toHaveLength(1);
		expect(tastings[0]).toMatchObject({ drankOn: "2026-08-02" });
	});

	it("新規作成エントリに足した試飲記録もエントリごと消える", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [
				{ wine: { name: "新規のワイン" }, tasting: { drankOn: "2026-08-01" } },
			],
		});

		await undoImportBatch(userId, result.batchId);

		expect((await listDrunkWines(userId)).entries).toHaveLength(0);
		// 取り残された試飲記録が無いこと(エントリが消えても行だけ残ると集計が壊れる)
		const leftover = await db
			.select()
			.from(wineTasting)
			.where(eq(wineTasting.userId, userId));
		expect(leftover).toHaveLength(0);
	});
});

// ---- getImportBatch(履歴からの再解析の材料, Issue #427) --------------------

describe("getImportBatch", () => {
	// 1x1 JPEG(マジックバイト検証を通る最小の実データ)
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	it("保存した写真URLを撮影順で返す(photoIndex の順と一致する)", async () => {
		// 順序が崩れると「別の写真で見かけたことになる」。再解析はこの順で写真を
		// 読み直して新バッチを作るので、ここが回帰防止の要になる。
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 2,
			items: [{ wine: { name: "順序の確認" }, sighting: { photoIndex: 1 } }],
		});
		const saved = await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		const batch = await getImportBatch(userId, result.batchId);

		expect(batch.photoUrls).toEqual(saved.photoUrls);
		expect(batch.photoUrls).toHaveLength(2);
		// 再解析は場所・見かけた日も引き継ぐ
		expect(batch.id).toBe(result.batchId);
	});

	it("場所と見かけた日を引き継げる形で返す", async () => {
		const userId = await freshUser();
		const shop = await createPlace(userId, { name: "やり直す店" });
		const result = await bulkRegisterFromScan(userId, {
			placeId: shop.id,
			seenOn: "2026-07-20",
			photoCount: 0,
			items: [{ wine: { name: "場所つき" } }],
		});

		const batch = await getImportBatch(userId, result.batchId);

		expect(batch.placeId).toBe(shop.id);
		expect(batch.seenOn).toBe("2026-07-20");
		expect(batch.photoUrls).toEqual([]);
	});

	it("他人のバッチは取得できない(404)", async () => {
		const userId = await freshUser();
		const stranger = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "他人のもの" } }],
		});

		await expect(
			getImportBatch(stranger, result.batchId),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

// ---- listImportBatches(バッチ履歴の一覧, Issue #380) -----------------------

describe("listImportBatches", () => {
	it("新しい順に一覧し、場所名・件数・目撃記録の内訳を含める", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, { name: "既存のワイン" });

		const first = await bulkRegisterFromScan(userId, {
			newPlace: { name: "1軒目" },
			seenOn: "2026-07-01",
			photoCount: 2,
			items: [
				{ wine: { name: "新規A" } },
				{ wine: undefined, existingId: existing.id },
			],
		});
		// bulkRegisterFromScan の photoCount は解析枚数の申告値で、バッチの実写真
		// (import_batch.photo_keys)は saveImportBatchPhotos(2段階目)まで空のまま
		await db
			.update(importBatch)
			.set({ createdAt: new Date(1000) })
			.where(eq(importBatch.id, first.batchId));

		const second = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "新規B" } }],
		});
		await db
			.update(importBatch)
			.set({ createdAt: new Date(2000) })
			.where(eq(importBatch.id, second.batchId));

		const batches = await listImportBatches(userId);
		expect(batches.map((b) => b.id)).toEqual([second.batchId, first.batchId]);

		expect(batches.find((b) => b.id === first.batchId)).toMatchObject({
			placeName: "1軒目",
			seenOn: "2026-07-01",
			photoCount: 0,
			createdCount: 1,
			matchedCount: 1,
			sightingCount: 2,
			hasEditedEntries: false,
		});
	});

	it("登録後に編集された新規エントリは hasEditedEntries を立てる", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "後で編集される" } }],
		});
		const entryId = (await listDrunkWines(userId)).entries[0]?.id as string;
		// 実時間を待たずに「作成からしばらく経って更新された」状態を直接作る
		// (updatedAt の既定値と同じ式で作られる createdAt との差は通常 1ms 未満なので、
		// この閾値を跨がない限り実際の編集とは区別できる)
		await db
			.update(drunkWine)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(drunkWine.id, entryId));

		const [summary] = await listImportBatches(userId);
		expect(summary).toMatchObject({
			id: result.batchId,
			hasEditedEntries: true,
		});
	});

	it("全エントリが個別削除済みのバッチは0件のまま一覧に残る", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "後で個別削除される" } }],
		});
		const entryId = (await listDrunkWines(userId)).entries[0]?.id as string;
		await deleteDrunkWine(userId, entryId);

		const [summary] = await listImportBatches(userId);
		expect(summary).toMatchObject({
			id: result.batchId,
			createdCount: 0,
			sightingCount: 0,
		});
	});

	it("他ユーザのバッチは一覧に出ない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		await bulkRegisterFromScan(owner, {
			photoCount: 0,
			items: [{ wine: { name: "他人のバッチ" } }],
		});

		expect(await listImportBatches(stranger)).toEqual([]);
	});

	it("取り消したバッチは一覧から消える", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 0,
			items: [{ wine: { name: "取り消されるワイン" } }],
		});

		await undoImportBatch(userId, result.batchId);

		expect(await listImportBatches(userId)).toEqual([]);
	});
});

describe("saveImportBatchPhotos", () => {
	const JPEG_1X1_BYTES = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	async function seedBatch(userId: string): Promise<string> {
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [
				{ wine: { name: "写真つきの一括登録" }, sighting: { photoIndex: 0 } },
			],
		});
		return result.batchId;
	}

	it("バッチに1回だけ写真を置き、目撃記録の photoIndex が指す配列を確定する", async () => {
		const userId = await freshUser();
		const batchId = await seedBatch(userId);

		const batch = await saveImportBatchPhotos(userId, batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		expect(batch.photoUrls).toHaveLength(1);
		const key = imageKeyFromPath(batch.photoUrls[0] as string);
		// 認可・署名URL・退会時削除が前提にしている wines/{userId}/{中間ID}/ のレイアウト
		expect(key.startsWith(`wines/${userId}/${batchId}/`)).toBe(true);
		expect(await env.AVATARS.head(key)).not.toBeNull();
	});

	it("画像として認識できないファイルは保存しない(申告MIMEを信用しない #150)", async () => {
		const userId = await freshUser();
		const batchId = await seedBatch(userId);

		await expect(
			saveImportBatchPhotos(userId, batchId, [
				{
					bytes: new TextEncoder().encode("<html>not an image</html>"),
					mimeType: "image/jpeg",
				},
			]),
		).rejects.toBeInstanceOf(BadRequestError);
	});

	it("保存済みのバッチへの再アップロードは拒否する(photoIndex がずれるため)", async () => {
		const userId = await freshUser();
		const batchId = await seedBatch(userId);
		await saveImportBatchPhotos(userId, batchId, [
			{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
		]);

		await expect(
			saveImportBatchPhotos(userId, batchId, [
				{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow("保存済み");
	});

	it("他ユーザのバッチには保存できない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const batchId = await seedBatch(owner);

		await expect(
			saveImportBatchPhotos(stranger, batchId, [
				{ bytes: JPEG_1X1_BYTES, mimeType: "image/jpeg" },
			]),
		).rejects.toThrow("Import batch not found");
	});

	// Issue #405: 登録時の申告枚数(photoCount)は zod の検証にしか使われず永続化
	// されていなかったため、2段階目は「申告どおりの枚数が来たか」を確認できなかった。
	// 申告より少ない枚数が入ると、目撃記録の photoIndex が配列外(写真が出ない)か、
	// 前段が抜けた繰り上がりで**別の写真**を指す。
	describe("申告枚数との照合 (#405)", () => {
		/** photoIndex が 0,1,2 を指す3枚申告のバッチ。 */
		async function seedBatchOf3(userId: string): Promise<string> {
			const result = await bulkRegisterFromScan(userId, {
				photoCount: 3,
				items: [
					{ wine: { name: "1枚目のワイン" }, sighting: { photoIndex: 0 } },
					{ wine: { name: "2枚目のワイン" }, sighting: { photoIndex: 1 } },
					{ wine: { name: "3枚目のワイン" }, sighting: { photoIndex: 2 } },
				],
			});
			return result.batchId;
		}

		const jpeg = () => ({
			bytes: JPEG_1X1_BYTES,
			mimeType: "image/jpeg",
		});

		it("申告枚数を import_batch に残す", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			const [row] = await db
				.select({ photoCount: importBatch.photoCount })
				.from(importBatch)
				.where(eq(importBatch.id, batchId));
			expect(row?.photoCount).toBe(3);
		});

		it("申告より少ない枚数は拒否し、R2にも書かない", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			await expect(
				saveImportBatchPhotos(userId, batchId, [jpeg(), jpeg()]),
			).rejects.toBeInstanceOf(BadRequestError);

			// 拒否は R2 へ書く前に起きる(孤児オブジェクトを作らない)
			const objects = await env.AVATARS.list({
				prefix: `wines/${userId}/${batchId}/`,
			});
			expect(objects.objects).toHaveLength(0);
			// 写真キーも空のまま = やり直せる
			const [row] = await db
				.select({ photoKeys: importBatch.photoKeys })
				.from(importBatch)
				.where(eq(importBatch.id, batchId));
			expect(row?.photoKeys).toEqual([]);
		});

		it("申告より多い枚数も拒否する(順序がずれて別の写真を指すため)", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			await expect(
				saveImportBatchPhotos(userId, batchId, [
					jpeg(),
					jpeg(),
					jpeg(),
					jpeg(),
				]),
			).rejects.toBeInstanceOf(BadRequestError);
		});

		it("申告どおりの枚数なら通る", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);

			const batch = await saveImportBatchPhotos(userId, batchId, [
				jpeg(),
				jpeg(),
				jpeg(),
			]);
			expect(batch.photoUrls).toHaveLength(3);
		});

		it("申告枚数を持たない既存バッチ(photo_count=null)は照合をスキップする", async () => {
			const userId = await freshUser();
			const batchId = await seedBatchOf3(userId);
			// この列を持つ前に作られたバッチを再現する
			await db
				.update(importBatch)
				.set({ photoCount: null })
				.where(eq(importBatch.id, batchId));

			const batch = await saveImportBatchPhotos(userId, batchId, [jpeg()]);
			expect(batch.photoUrls).toHaveLength(1);
		});
	});
});

// 閲覧側(Issue #358 PR4)。目撃記録の由来写真の解決と、場所での絞り込みを実D1で見る。
describe("目撃記録の由来写真", () => {
	const JPEG_1X1 = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);

	it("バッチの photoIndex 番目の写真URLを返す", async () => {
		const userId = await freshUser();
		const result = await bulkRegisterFromScan(userId, {
			photoCount: 2,
			items: [
				{ wine: { name: "2枚目に写っていた" }, sighting: { photoIndex: 1 } },
			],
		});
		const batch = await saveImportBatchPhotos(userId, result.batchId, [
			{ bytes: JPEG_1X1, mimeType: "image/jpeg" },
			{ bytes: JPEG_1X1, mimeType: "image/jpeg" },
		]);

		const { entries } = await listDrunkWines(userId);
		const [sighting] = await listWineSightings(userId, entries[0]?.id ?? "");
		// 1枚目ではなく2枚目(photoIndex=1)を指す
		expect(sighting?.photoUrl).toBe(batch.photoUrls[1]);
	});

	it("写真がまだ保存されていないバッチでは null(壊れた画像URLを作らない)", async () => {
		const userId = await freshUser();
		await bulkRegisterFromScan(userId, {
			photoCount: 1,
			items: [{ wine: { name: "写真未保存" }, sighting: { photoIndex: 0 } }],
		});
		const { entries } = await listDrunkWines(userId);
		const [sighting] = await listWineSightings(userId, entries[0]?.id ?? "");
		expect(sighting?.batchId).not.toBeNull();
		expect(sighting?.photoUrl).toBeNull();
	});

	it("手で足した目撃記録(バッチ無し)は null", async () => {
		const userId = await freshUser();
		const { id } = await createDrunkWine(userId, { name: "手入力" });
		await addWineSighting(userId, id, { seenOn: "2026-08-01" });
		const [sighting] = await listWineSightings(userId, id);
		expect(sighting?.photoUrl).toBeNull();
	});
});

describe("場所での絞り込み", () => {
	it("その場所で見かけた銘柄だけを返し、チップの件数も同じ母集合で数える", async () => {
		const userId = await freshUser();
		const shop = await createPlace(userId, { name: "ワインショップA" });
		const other = await createPlace(userId, { name: "レストランB" });

		await bulkRegisterFromScan(userId, {
			placeId: shop.id,
			photoCount: 0,
			items: [
				{ wine: { name: "Aで見かけた1" } },
				{ wine: { name: "Aで見かけた2", status: "owned" } },
			],
		});
		await bulkRegisterFromScan(userId, {
			placeId: other.id,
			photoCount: 0,
			items: [{ wine: { name: "Bで見かけた" } }],
		});
		// どの場所でも見かけていない銘柄(絞り込みから外れる)
		await createDrunkWine(userId, { name: "見かけていない" });

		const all = await listDrunkWines(userId);
		expect(all.entries).toHaveLength(4);

		const atShop = await listDrunkWines(userId, { placeId: shop.id });
		expect(atShop.entries.map((e) => e.name).sort()).toEqual([
			"Aで見かけた1",
			"Aで見かけた2",
		]);

		// チップの件数も場所で絞る(一覧と数字が食い違わない)
		const counts = await countCellarFilters(userId, { placeId: shop.id });
		expect(counts).toMatchObject({ all: 2, owned: 1, spotted: 1 });
		expect(await countCellarFilters(userId)).toMatchObject({ all: 4 });
	});

	it("場所と所有状態は直交する(両方で絞れる)", async () => {
		const userId = await freshUser();
		const shop = await createPlace(userId, { name: "ショップ" });
		await bulkRegisterFromScan(userId, {
			placeId: shop.id,
			photoCount: 0,
			items: [
				{ wine: { name: "見かけただけ" } },
				{ wine: { name: "見かけて買った", status: "owned" } },
			],
		});

		const owned = await listDrunkWines(userId, {
			placeId: shop.id,
			filter: "owned",
		});
		expect(owned.entries.map((e) => e.name)).toEqual(["見かけて買った"]);
	});

	it("同じ場所で複数回見かけた銘柄が重複して出ない(EXISTS で畳む)", async () => {
		const userId = await freshUser();
		const shop = await createPlace(userId, { name: "常連の店" });
		const { id } = await createDrunkWine(userId, { name: "何度も見かけた" });
		await addWineSighting(userId, id, {
			placeId: shop.id,
			seenOn: "2026-07-01",
		});
		await addWineSighting(userId, id, {
			placeId: shop.id,
			seenOn: "2026-08-01",
		});

		const page = await listDrunkWines(userId, { placeId: shop.id });
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]?.sightingCount).toBe(2);
	});
});

// ---- 破壊的な一括削除の監査ライン(Issue #394) ------------------------------
//
// D1(cascade 込み)とR2にまたがる不可逆の削除は、成功時にも1行残さないと
// 「エントリが消えた」という問い合わせに対して「ユーザが消した / バグで消えた /
// そもそも無かった」を Workers Logs から区別できない。件数まで載せるのは、
// 異常な大量削除を後から検知できるようにするため。

describe("一括削除の監査ライン (#394)", () => {
	let lines: string[] = [];
	beforeEach(() => {
		lines = [];
		vi.spyOn(console, "info").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** 構造化ログ(1行JSON)を msg で拾う。 */
	function logged(msg: string): Record<string, unknown>[] {
		return lines
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((o): o is Record<string, unknown> => o?.msg === msg);
	}

	it("deleteDrunkWines は成功時に件数つきの info を残す", async () => {
		const userId = await freshUser();
		const other = await freshUser();
		const a = await createDrunkWine(userId, { name: "A" });
		const b = await createDrunkWine(userId, { name: "B" });
		const theirs = await createDrunkWine(other, { name: "他人の" });

		// 他人の id を混ぜる = 要求件数と削除件数がずれるケース
		await deleteDrunkWines(userId, [a.id, b.id, theirs.id]);

		const rows = logged("drunk wines bulk deleted");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			level: "info",
			userId,
			requestedCount: 3,
			deletedCount: 2,
		});
	});

	it("空配列の削除ではログを出さない(何も起きていない)", async () => {
		const userId = await freshUser();
		await deleteDrunkWines(userId, []);
		expect(logged("drunk wines bulk deleted")).toHaveLength(0);
	});

	it("undoImportBatch は成功時に取り消した内訳つきの info を残す", async () => {
		const userId = await freshUser();
		const existing = await createDrunkWine(userId, {
			name: "以前飲んだシャブリ",
			status: "spotted",
		});
		const result = await bulkRegisterFromScan(userId, {
			seenOn: "2026-08-01",
			photoCount: 0,
			items: [
				{ wine: { name: "新規のワイン" } },
				{
					wine: undefined,
					existingId: existing.id,
					tasting: { drankOn: "2026-08-01" },
				},
			],
		});

		await undoImportBatch(userId, result.batchId);

		const rows = logged("import batch undone");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			level: "info",
			userId,
			batchId: result.batchId,
			// 新規作成の1件が消え、既存エントリ1件は記録だけ取り消して再計算した
			deletedCount: 1,
			sightingCount: 2,
			tastingCount: 1,
			recomputedCount: 1,
		});
	});

	it("取り消せなかった場合(他ユーザのバッチ)はログを出さない", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const result = await bulkRegisterFromScan(owner, {
			photoCount: 0,
			items: [{ wine: { name: "他人のバッチ" } }],
		});

		await expect(undoImportBatch(stranger, result.batchId)).rejects.toThrow(
			NotFoundError,
		);
		expect(logged("import batch undone")).toHaveLength(0);
	});
});
