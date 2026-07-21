import { afterEach, describe, expect, it } from "vitest";
import {
	envBool,
	envInt,
	envSignedInt,
	fmtNumber,
	formatFileLine,
	padAnsi,
	parseNumstat,
	parseShortstat,
	shouldHideSidebar,
} from "../extensions/sidebar.js";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("configuration helpers", () => {
	it("parses boolean environment values with fallback", () => {
		expect(envBool("PI_TEST_MISSING", true)).toBe(true);
		process.env.PI_TEST_BOOL = "false";
		expect(envBool("PI_TEST_BOOL", true)).toBe(false);
		process.env.PI_TEST_BOOL = "1";
		expect(envBool("PI_TEST_BOOL", false)).toBe(true);
	});

	it("parses positive integer environment values with fallback", () => {
		expect(envInt("PI_TEST_MISSING", 34)).toBe(34);
		process.env.PI_TEST_INT = "42";
		expect(envInt("PI_TEST_INT", 34)).toBe(42);
		process.env.PI_TEST_INT = "0";
		expect(envInt("PI_TEST_INT", 34)).toBe(34);
		process.env.PI_TEST_INT = "nope";
		expect(envInt("PI_TEST_INT", 34)).toBe(34);
	});

	it("parses signed integer environment values with fallback", () => {
		expect(envSignedInt("PI_TEST_MISSING", -6)).toBe(-6);
		process.env.PI_TEST_SIGNED_INT = "-4";
		expect(envSignedInt("PI_TEST_SIGNED_INT", -6)).toBe(-4);
		process.env.PI_TEST_SIGNED_INT = "0";
		expect(envSignedInt("PI_TEST_SIGNED_INT", -6)).toBe(0);
		process.env.PI_TEST_SIGNED_INT = "nope";
		expect(envSignedInt("PI_TEST_SIGNED_INT", -6)).toBe(-6);
	});

	it("hides the sidebar while streaming when autohide is enabled", () => {
		expect(shouldHideSidebar({ enabled: true, isStreaming: true }, true)).toBe(
			true,
		);
		expect(shouldHideSidebar({ enabled: true, isStreaming: true }, false)).toBe(
			false,
		);
		expect(
			shouldHideSidebar({ enabled: false, isStreaming: false }, true),
		).toBe(true);
	});
});

describe("git parsing", () => {
	it("parses git diff shortstat variants", () => {
		expect(
			parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)"),
		).toEqual({
			changedFiles: 3,
			insertions: 10,
			deletions: 2,
		});
		expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({
			changedFiles: 1,
			insertions: 1,
			deletions: 0,
		});
		expect(parseShortstat("")).toEqual({
			changedFiles: 0,
			insertions: 0,
			deletions: 0,
		});
	});

	it("parses per-file numstat deltas", () => {
		expect(
			parseNumstat("10\t2\textensions/sidebar.ts\n-\t-\timage.png"),
		).toEqual(
			new Map([
				["extensions/sidebar.ts", "+10/-2"],
				["image.png", "bin"],
			]),
		);
	});
});

describe("formatting helpers", () => {
	it("formats numbers and pads lines by visible width", () => {
		expect(fmtNumber(999)).toBe("999");
		expect(fmtNumber(1536)).toBe("1.5k");
		expect(padAnsi("abc", 5)).toBe("abc  ");
		const fileLine = formatFileLine(
			{ code: "M", path: "src/very-long-file-name.ts", delta: "+10/-2" },
			18,
		).replace(/\u001b\[[0-9;]*m/g, "");
		expect(fileLine).toBe("M  src/ver… +10/-2");
	});
});
