import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { aopReferenceLink } from "#/db/schema";
import { BadRequestError } from "#/lib/errors";
import {
	createReferenceLink,
	deleteReferenceLink,
	listReferenceLinks,
} from "./reference-link-service";

// D1(実SQLite)上で、参考リンクの AOP スコープを検証する。aop_id は静的マスタへの
// FK 無し参照なので、マスタ側で ID が消える・変わると保存済みのリンクが到達不能に
// なりうる(#333)。退役IDの解決がその救済になっていることをここで固定する。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `ref-link-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "reference link tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

describe("listReferenceLinks", () => {
	it("自分の・そのAOPのリンクだけを返す", async () => {
		const mine = await freshUser();
		const other = await freshUser();
		await createReferenceLink(mine, {
			aopId: "chablis",
			url: "https://example.com/chablis",
			title: "シャブリ",
		});
		await createReferenceLink(mine, {
			aopId: "brouilly",
			url: "https://example.com/brouilly",
			title: "ブルイィ",
		});
		await createReferenceLink(other, {
			aopId: "chablis",
			url: "https://example.com/other",
			title: "他人のリンク",
		});

		const links = await listReferenceLinks(mine, "chablis");
		expect(links.map((l) => l.title)).toEqual(["シャブリ"]);
	});

	it("台帳にも無い未知のAOPは弾く", async () => {
		const userId = await freshUser();
		await expect(listReferenceLinks(userId, "no-such-aop")).rejects.toThrow(
			BadRequestError,
		);
	});
});

// #333: マスタから ID が消えると、その AOP に保存したリンクは
// 「Unknown AOP で一覧が落ちる = 閲覧も削除もできない」到達不能データになる。
// 退役IDに後継を登録してあれば、後継AOPの画面から今までどおり扱える。
describe("退役AOP IDで保存されたリンクの救済 (#333)", () => {
	it("後継AOPの一覧に出て、削除もできる", async () => {
		const userId = await freshUser();
		const link = await createReferenceLink(userId, {
			aopId: "saint-emilion-grand-cru",
			url: "https://example.com/la-gaffeliere",
			title: "ラ・ガフリエール",
		});
		// マスタから消える前(#216 以前)に保存されたリンクを再現する
		await db
			.update(aopReferenceLink)
			.set({ aopId: "chateau-la-gaffeliere" })
			.where(eq(aopReferenceLink.id, link.id));

		const links = await listReferenceLinks(userId, "saint-emilion-grand-cru");
		expect(links.map((l) => l.title)).toContain("ラ・ガフリエール");

		await deleteReferenceLink(userId, link.id);
		expect(await listReferenceLinks(userId, "saint-emilion-grand-cru")).toEqual(
			[],
		);
	});

	it("退役IDで作成しても、保存されるのは後継のID", async () => {
		const userId = await freshUser();
		const link = await createReferenceLink(userId, {
			aopId: "chateau-la-gaffeliere",
			url: "https://example.com/legacy-create",
			title: "旧IDで作成",
		});
		expect(link.aopId).toBe("saint-emilion-grand-cru");
	});
});
