import { describe, expect, it } from "vitest";
import { appendWineNote, buildWineNote, NOTE_SECTION_LABELS } from "./note";
import { NOTE_MAX } from "./schema";

// 銘柄のコメントの組み立て(#471 / #473)。書き手が複数(解析のコメント・アプリの
// 生産者解説・web写真のズレの注記)いるフィールドなので、見出しと上限の扱いを固定する。

describe("buildWineNote", () => {
	it("香り・味わいと生産者を見出し付きの段落に畳む", () => {
		expect(
			buildWineNote({ tasting: "柑橘と火打石。", producer: "老舗。" }),
		).toBe(
			`${NOTE_SECTION_LABELS.tasting}\n柑橘と火打石。\n\n${NOTE_SECTION_LABELS.producer}\n老舗。`,
		);
	});

	it("片方だけでも組み立てる / どちらも無ければ undefined", () => {
		expect(buildWineNote({ tasting: "柑橘。" })).toBe(
			`${NOTE_SECTION_LABELS.tasting}\n柑橘。`,
		);
		expect(buildWineNote({})).toBeUndefined();
	});

	it("extra は末尾の段落として足す(写真の注記 #473)", () => {
		const note = buildWineNote({
			tasting: "柑橘。",
			extra: `${NOTE_SECTION_LABELS.photo}\n写真は2019年のものです。`,
		});
		expect(note?.endsWith("写真は2019年のものです。")).toBe(true);
	});

	it("上限を超えたら切り詰める(保存で弾かれる袋小路を作らない)", () => {
		const note = buildWineNote({ tasting: "あ".repeat(NOTE_MAX + 100) });
		expect(note?.length).toBeLessThanOrEqual(NOTE_MAX);
	});
});

describe("appendWineNote", () => {
	it("既存コメントの後ろへ段落として足す", () => {
		expect(appendWineNote("柑橘。", "写真は別年。")).toBe(
			"柑橘。\n\n写真は別年。",
		);
	});

	it("片方だけでも成立する(解析がコメントを書かなかった銘柄にも注記は付く)", () => {
		expect(appendWineNote(null, "写真は別年。")).toBe("写真は別年。");
		expect(appendWineNote("柑橘。", undefined)).toBe("柑橘。");
	});

	it("どちらも無ければ null(列がそのまま NULL になる形)", () => {
		expect(appendWineNote(null, null)).toBeNull();
		expect(appendWineNote("  ", "")).toBeNull();
	});

	it("上限を超えたら切り詰める", () => {
		const appended = appendWineNote("あ".repeat(NOTE_MAX), "追記");
		expect(appended?.length).toBe(NOTE_MAX);
	});
});
