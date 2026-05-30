import { afterEach, describe, expect, it } from "vitest";
import {
	SidebarComponent,
	envBool,
	envInt,
	envSignedInt,
	fmtNumber,
	formatFileLine,
	padAnsi,
	parseNumstat,
	parseShortstat,
	shouldHideSidebar,
	type GitState,
	type SidebarState,
} from "../extensions/sidebar.js";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

function state(overrides: Partial<SidebarState> = {}): SidebarState {
	return {
		enabled: true,
		gitDetail: true,
		fullHeight: true,
		git: {
			insideRepo: true,
			branch: "main",
			files: [],
			insertions: 0,
			deletions: 0,
			changedFiles: 0,
		},
		turnCount: 0,
		isStreaming: false,
		...overrides,
	};
}

function component(
	git: Partial<GitState>,
	overrides: Partial<SidebarState> = {},
	componentTheme: typeof theme = theme,
) {
	return new SidebarComponent(
		() =>
			({
				cwd: "/repo/project",
				model: { provider: "anthropic", id: "claude-sonnet" },
				getContextUsage: () => ({
					tokens: 1536,
					percent: 12.5,
					contextWindow: 200000,
				}),
				sessionManager: { getSessionName: () => "Test Session" },
			}) as any,
		state({
			git: {
				insideRepo: true,
				branch: "feature/sidebar",
				files: [],
				insertions: 2,
				deletions: 1,
				changedFiles: 1,
				...git,
			},
			...overrides,
		}),
		componentTheme as any,
		{ maxFiles: 2, buffer: 1, fillRows: 24, getThinkingLevel: () => "medium" },
	);
}

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

describe("SidebarComponent rendering", () => {
	it("renders full-height sidebar with gutter, summary, and filler rows", () => {
		const rendered = component({
			files: [{ code: "M", path: "extensions/sidebar.ts" }],
		}).render(48);
		expect(rendered).toHaveLength(24);
		expect(rendered[0]).toMatch(/^ │ Model/);
		expect(rendered.join("\n")).toContain("claude-sonnet • medium");
		expect(rendered.join("\n")).toContain("anthropic");
		expect(rendered.join("\n")).toContain("13% • 1.5k of 200.0k");
		expect(rendered.join("\n")).toContain("feature/sidebar");
		expect(rendered.join("\n")).toContain("1 files");
		expect(rendered.join("\n")).toContain("+2 -1");
		expect(rendered.join("\n")).toContain("extensions/sidebar.ts");
		expect(rendered.join("\n")).toContain("/sidebar status");
	});

	it("colors add and delete portions of per-file deltas", () => {
		const taggedTheme = {
			fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
			bold: (text: string) => text,
		};
		const rendered = component(
			{
				files: [
					{
						code: "M",
						path: "docs/superpowers/sidebar.md",
						delta: "+506/-130",
					},
				],
			},
			{ fullHeight: false },
			taggedTheme,
		)
			.render(200)
			.join("\n");
		expect(rendered).toContain("<toolDiffAdded>+506</toolDiffAdded>");
		expect(rendered).toContain("<toolDiffRemoved>-130</toolDiffRemoved>");
	});

	it("limits file rows when git detail is reduced", () => {
		const files = [
			{ code: "M", path: "a.ts" },
			{ code: "A", path: "b.ts" },
			{ code: "D", path: "c.ts" },
		];
		const rendered = component({ files, changedFiles: 3 }, { gitDetail: false })
			.render(36)
			.join("\n");
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("b.ts");
		expect(rendered).not.toContain("c.ts");
		expect(rendered).toContain("…1 more");
	});

	it("does not add full-height gutter or filler rows in floating mode", () => {
		const rendered = component({}, { fullHeight: false }).render(36);
		expect(rendered.length).toBeLessThan(24);
		expect(rendered[0]).toMatch(/^│ Model/);
	});
});
