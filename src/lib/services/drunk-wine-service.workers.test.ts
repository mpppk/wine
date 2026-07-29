import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { drunkWine, wineTasting } from "#/db/schema";
import {
	CELLAR_FILTER_IDS,
	countCellarFilters as countCellarFiltersPure,
	matchesCellarFilter,
} from "#/lib/drunk-wine/filter";
import { thumbKeyForPhotoKey } from "#/lib/drunk-wine/photo";
import type { WineStatus } from "#/lib/drunk-wine/status";
import { BadRequestError } from "#/lib/errors";
import { imageKeyFromPath } from "#/lib/images/signed-url";
import {
	addWineTasting,
	countCellarFilters,
	createDrunkWine,
	deleteDrunkWine,
	deleteWineTasting,
	getCellarSummary,
	getDrunkWine,
	listDrunkWines,
	listWineTastings,
	markWineDrunk,
	syncDrunkWinePhotos,
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
		expect(entry.lastRating).toBe(5);
		expect(entry.lastMemo).toBe("好み");
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

describe("写真同期の巻き戻し (#249)", () => {
	const JPEG_1X1 = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
		),
		(c) => c.charCodeAt(0),
	);
	/** 画像として認識できないバイト列(resolveStoredPhotoMime が弾く) */
	const NOT_AN_IMAGE = new TextEncoder().encode("<html>not an image</html>");

	/** R2 の delete だけを失敗させる(put/head は素通し) */
	function breakDelete(): () => void {
		const bucket = env.AVATARS as unknown as { delete: unknown };
		const original = bucket.delete;
		bucket.delete = () => Promise.reject(new Error("R2 unavailable"));
		return () => {
			bucket.delete = original;
		};
	}

	it("巻き戻しに失敗しても元の 400 が 500 に化けない", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "巻き戻し" });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const restore = breakDelete();
		try {
			// 1枚目は保存され(=巻き戻し対象ができる)、2枚目の検証で弾かれる
			await expect(
				syncDrunkWinePhotos(userId, entry.id, [
					{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
					{ kind: "new", bytes: NOT_AN_IMAGE, mimeType: "image/jpeg" },
				]),
			).rejects.toBeInstanceOf(BadRequestError);
		} finally {
			restore();
		}

		// 補償の失敗は握り潰さずログに残す(真因を追えるよう元例外も添える)
		// mockRestore は calls も消すので、読み終えてから戻す
		const line = JSON.parse(String(errors.mock.calls[0]?.[0]));
		errors.mockRestore();
		expect(line).toMatchObject({
			level: "error",
			msg: "photo rollback failed",
			userId,
			entryId: entry.id,
		});
		expect(line.err).toContain("R2 unavailable");
		expect(line.originalErr).toContain("BadRequestError");
	});

	it("巻き戻しに成功した場合はログを出さない(障害シグナルを薄めない)", async () => {
		const userId = await freshUser();
		const entry = await createDrunkWine(userId, { name: "正常な巻き戻し" });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				syncDrunkWinePhotos(userId, entry.id, [
					{ kind: "new", bytes: JPEG_1X1, mimeType: "image/jpeg" },
					{ kind: "new", bytes: NOT_AN_IMAGE, mimeType: "image/jpeg" },
				]),
			).rejects.toBeInstanceOf(BadRequestError);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});
