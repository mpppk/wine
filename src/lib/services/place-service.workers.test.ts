import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { importBatch, place, wineSighting } from "#/db/schema";
import { NotFoundError } from "#/lib/errors";
import { addWineSighting, createDrunkWine } from "./drunk-wine-service";
import {
	createPlace,
	deletePlace,
	getPlace,
	listPlaces,
	updatePlace,
} from "./place-service";

// 場所(place)は「どの店でワインを見かけたか」のユーザ単位マスタ(Issue #358)。
// 実D1で確認したいのは (a) 所有権が JOIN 無しの WHERE id AND user_id で閉じること、
// (b) 参照側の ON DELETE 挙動(set null であって cascade ではない)の2点。
// どちらも純関数へ切り出せず、実際にクエリを走らせないと守れない。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `place-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "place tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

describe("createPlace / getPlace", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("名前だけで作れ、区分は既定の other になる", async () => {
		const p = await createPlace(userId, { name: "ワインバー中目黒" });
		expect(p.name).toBe("ワインバー中目黒");
		// マイグレーションの DEFAULT と DEFAULT_PLACE_KIND が揃っていることの確認も兼ねる
		expect(p.kind).toBe("other");
		expect(p.memo).toBeNull();
	});

	it("区分とメモを指定できる", async () => {
		const p = await createPlace(userId, {
			name: "伊勢丹",
			kind: "shop",
			memo: "地下のワイン売場",
		});
		expect(p.kind).toBe("shop");
		expect(p.memo).toBe("地下のワイン売場");
	});

	it("同名の場所を複数作れる(unique 制約は張っていない)", async () => {
		const a = await createPlace(userId, { name: "エノテカ" });
		const b = await createPlace(userId, { name: "エノテカ" });
		expect(a.id).not.toBe(b.id);
		expect(await listPlaces(userId)).toHaveLength(2);
	});
});

describe("listPlaces", () => {
	it("自分の場所だけを名前順で返す", async () => {
		const userId = await freshUser();
		const stranger = await freshUser();
		await createPlace(userId, { name: "b-shop" });
		await createPlace(userId, { name: "a-shop" });
		await createPlace(stranger, { name: "他人の店" });

		expect((await listPlaces(userId)).map((p) => p.name)).toEqual([
			"a-shop",
			"b-shop",
		]);
	});

	it("1件も無ければ空配列", async () => {
		expect(await listPlaces(await freshUser())).toEqual([]);
	});
});

describe("updatePlace", () => {
	it("undefined は変更しない / null はクリア", async () => {
		const userId = await freshUser();
		const p = await createPlace(userId, {
			name: "更新前",
			kind: "restaurant",
			memo: "消される",
		});

		const renamed = await updatePlace(userId, { id: p.id, name: "更新後" });
		expect(renamed.name).toBe("更新後");
		// 送らなかったキーは据え置き
		expect(renamed.kind).toBe("restaurant");
		expect(renamed.memo).toBe("消される");

		const cleared = await updatePlace(userId, { id: p.id, memo: null });
		expect(cleared.memo).toBeNull();
		expect(cleared.name).toBe("更新後");
	});

	it("差分が空でも現在値を返す(drizzle の空SETを踏まない)", async () => {
		const userId = await freshUser();
		const p = await createPlace(userId, { name: "無変更" });
		expect((await updatePlace(userId, { id: p.id })).name).toBe("無変更");
	});
});

describe("所有権", () => {
	it("他ユーザの場所は読めない・更新できない・消せない(すべて同一エラー)", async () => {
		const owner = await freshUser();
		const stranger = await freshUser();
		const p = await createPlace(owner, { name: "他人の行きつけ" });

		await expect(getPlace(stranger, p.id)).rejects.toThrow(NotFoundError);
		await expect(
			updatePlace(stranger, { id: p.id, name: "乗っ取り" }),
		).rejects.toThrow("Place not found");
		await expect(deletePlace(stranger, p.id)).rejects.toThrow(
			"Place not found",
		);
		// 他ユーザの操作で実データが変わっていないこと
		expect((await getPlace(owner, p.id)).name).toBe("他人の行きつけ");
	});

	it("存在しないIDも「他ユーザ所有」と同じエラーになる(存在探索を防ぐ)", async () => {
		const userId = await freshUser();
		await expect(getPlace(userId, "no-such-place")).rejects.toThrow(
			"Place not found",
		);
	});
});

describe("deletePlace の参照側への影響", () => {
	it("目撃記録・一括登録バッチの place_id が null になり、行自体は残る", async () => {
		const userId = await freshUser();
		const p = await createPlace(userId, { name: "閉店した店" });
		const { id: wineId } = await createDrunkWine(userId, { name: "Chablis" });

		const batchId = crypto.randomUUID();
		await db.insert(importBatch).values({
			id: batchId,
			userId,
			placeId: p.id,
			seenOn: "2024-05-05",
			photoKeys: [`wines/${userId}/${batchId}/a.jpg`],
		});
		await addWineSighting(userId, wineId, {
			placeId: p.id,
			batchId,
			seenOn: "2024-05-05",
		});

		await deletePlace(userId, p.id);

		const sightings = await db
			.select()
			.from(wineSighting)
			.where(eq(wineSighting.drunkWineId, wineId));
		expect(sightings).toHaveLength(1);
		expect(sightings[0]?.placeId).toBeNull();
		// バッチへの参照は場所とは無関係なので残る
		expect(sightings[0]?.batchId).toBe(batchId);

		const batches = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, batchId));
		expect(batches).toHaveLength(1);
		expect(batches[0]?.placeId).toBeNull();
	});
});

describe("ユーザ削除のカスケード", () => {
	it("place / import_batch / wine_sighting がユーザごと消える", async () => {
		const userId = await freshUser();
		const p = await createPlace(userId, { name: "消える店" });
		const { id: wineId } = await createDrunkWine(userId, {
			name: "消えるワイン",
		});
		const batchId = crypto.randomUUID();
		await db.insert(importBatch).values({ id: batchId, userId, placeId: p.id });
		await addWineSighting(userId, wineId, { placeId: p.id, batchId });

		await db.delete(user).where(eq(user.id, userId));

		expect(
			await db.select().from(place).where(eq(place.userId, userId)),
		).toEqual([]);
		expect(
			await db.select().from(importBatch).where(eq(importBatch.userId, userId)),
		).toEqual([]);
		expect(
			await db
				.select()
				.from(wineSighting)
				.where(eq(wineSighting.userId, userId)),
		).toEqual([]);
	});
});
