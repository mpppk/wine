import { describe, expect, it } from "vitest";
import {
	type AnalyzeGateInput,
	analyzeBlockReason,
	type FormPhotoIdentity,
	formPhotoSetKey,
	photoSetKey,
	savedEntryPhotoSetKey,
} from "./analysis-gate";

// 解析ボタンの開閉はクレジット消費に直結するので、「押せてしまう窓」を固定する。

const READY: AnalyzeGateInput = {
	photoKey: photoSetKey(["p0", "p1"]),
	analyzedPhotoKey: null,
	photoCount: 2,
	analyzing: false,
	loadingPhotos: false,
	insufficientCredits: false,
	missingPlaceName: false,
};

describe("photoSetKey", () => {
	it("同じ写真・同じ順なら同じ印になる", () => {
		expect(photoSetKey(["p0", "p1"])).toBe(photoSetKey(["p0", "p1"]));
	});

	it("並べ替えは別の印になる(候補の写真番号が並び順を指すため)", () => {
		expect(photoSetKey(["p0", "p1"])).not.toBe(photoSetKey(["p1", "p0"]));
	});

	it("写真の増減で印が変わる", () => {
		expect(photoSetKey(["p0", "p1"])).not.toBe(photoSetKey(["p0"]));
		expect(photoSetKey(["p0"])).not.toBe(photoSetKey(["p0", "p2"]));
	});

	it("写真0枚は空の印になる", () => {
		expect(photoSetKey([])).toBe("");
	});
});

describe("savedEntryPhotoSetKey", () => {
	// 記録フォームは解析の投入時に保存し、新規写真はそこで R2 キーを持つ。
	// 振り直し後の印を保存後の写真キーの並びから組み立てる。

	it("保存後のキーの並びの印になる", () => {
		expect(savedEntryPhotoSetKey(["wines/u1/e1/p1.jpg"])).toBe(
			formPhotoSetKey([{ kind: "existing", key: "wines/u1/e1/p1.jpg" }]),
		);
	});

	it("キーが違えば別の印になる", () => {
		expect(savedEntryPhotoSetKey(["x.jpg"])).not.toBe(
			savedEntryPhotoSetKey(["y.jpg"]),
		);
	});

	it("写真0枚は空の印になる", () => {
		expect(savedEntryPhotoSetKey([])).toBe("");
	});
});

describe("formPhotoSetKey", () => {
	// 記録フォーム用の印。既存写真は R2 キー、新規写真はファイルの安定識別子
	// (名前+サイズ+lastModified)で指す——localId は保存で振り直されるため使わない。

	const existing = (key: string): FormPhotoIdentity => ({
		kind: "existing",
		key,
	});
	const picked = (
		name: string,
		size = 100,
		lastModified = 1000,
	): FormPhotoIdentity => ({
		kind: "new",
		file: { name, size, lastModified },
	});

	it("同じ集合なら同じ印になる", () => {
		expect(formPhotoSetKey([existing("a"), picked("p.jpg")])).toBe(
			formPhotoSetKey([existing("a"), picked("p.jpg")]),
		);
	});

	it("並べ替えは別の印になる(候補の写真番号が並び順を指すため)", () => {
		expect(formPhotoSetKey([existing("a"), existing("b")])).not.toBe(
			formPhotoSetKey([existing("b"), existing("a")]),
		);
	});

	it("写真の増減で印が変わる", () => {
		expect(formPhotoSetKey([existing("a"), existing("b")])).not.toBe(
			formPhotoSetKey([existing("a")]),
		);
	});

	it("同じ中身のファイルを選び直しても同じ印になる(localId に依存しない)", () => {
		expect(formPhotoSetKey([picked("p.jpg", 100, 1000)])).toBe(
			formPhotoSetKey([picked("p.jpg", 100, 1000)]),
		);
	});

	it("サイズ・更新時刻が違えば別の印になる", () => {
		expect(formPhotoSetKey([picked("p.jpg", 100, 1000)])).not.toBe(
			formPhotoSetKey([picked("p.jpg", 200, 1000)]),
		);
		expect(formPhotoSetKey([picked("p.jpg", 100, 1000)])).not.toBe(
			formPhotoSetKey([picked("p.jpg", 100, 2000)]),
		);
	});

	it("既存キーと新規ファイルは混ざらない", () => {
		expect(formPhotoSetKey([existing("p.jpg")])).not.toBe(
			formPhotoSetKey([picked("p.jpg")]),
		);
	});

	it("写真0枚は空の印になる", () => {
		expect(formPhotoSetKey([])).toBe("");
	});

	it("同一集合では already_analyzed になる", () => {
		const key = formPhotoSetKey([existing("a"), picked("p.jpg")]);
		expect(
			analyzeBlockReason({
				...READY,
				photoKey: key,
				analyzedPhotoKey: key,
			}),
		).toBe("already_analyzed");
	});
});

describe("analyzeBlockReason", () => {
	it("写真が揃っていれば押せる", () => {
		expect(analyzeBlockReason(READY)).toBeNull();
	});

	it("投入中・結果待ちの間は押せない", () => {
		expect(analyzeBlockReason({ ...READY, analyzing: true })).toBe("analyzing");
	});

	it("解析済みの写真から1枚も変えていなければ押せない", () => {
		expect(
			analyzeBlockReason({ ...READY, analyzedPhotoKey: READY.photoKey }),
		).toBe("already_analyzed");
	});

	it("解析後に写真を足せば、また押せる", () => {
		expect(
			analyzeBlockReason({
				...READY,
				analyzedPhotoKey: photoSetKey(["p0", "p1"]),
				photoKey: photoSetKey(["p0", "p1", "p2"]),
				photoCount: 3,
			}),
		).toBeNull();
	});

	it("解析後に写真を外しても、また押せる", () => {
		expect(
			analyzeBlockReason({
				...READY,
				analyzedPhotoKey: photoSetKey(["p0", "p1"]),
				photoKey: photoSetKey(["p0"]),
				photoCount: 1,
			}),
		).toBeNull();
	});

	it("写真0枚は押せない(解析済みの印が空でも同じ)", () => {
		expect(
			analyzeBlockReason({
				...READY,
				photoKey: photoSetKey([]),
				photoCount: 0,
			}),
		).toBe("no_photos");
	});

	it("保存済み写真の読み込み中は押せない", () => {
		expect(analyzeBlockReason({ ...READY, loadingPhotos: true })).toBe(
			"loading_photos",
		);
	});

	it("残高不足・場所名の未入力でも押せない", () => {
		expect(analyzeBlockReason({ ...READY, insufficientCredits: true })).toBe(
			"insufficient_credits",
		);
		expect(analyzeBlockReason({ ...READY, missingPlaceName: true })).toBe(
			"missing_place_name",
		);
	});

	it("解析済みの写真は、残高不足より先にその理由を出す(払っても解けないため)", () => {
		expect(
			analyzeBlockReason({
				...READY,
				analyzedPhotoKey: READY.photoKey,
				insufficientCredits: true,
			}),
		).toBe("already_analyzed");
	});
});
