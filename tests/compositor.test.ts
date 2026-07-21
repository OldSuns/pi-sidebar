import { describe, expect, it } from "vitest";
import { SidebarCompositor } from "../extensions/sidebar/compositor.js";
import type { SidebarState, GitState } from "../extensions/sidebar/types.js";
import type { Theme } from "../extensions/sidebar/types.js";

const DEFAULT_GIT: GitState = {
	insideRepo: false,
	files: [],
	insertions: 0,
	deletions: 0,
	changedFiles: 0,
};

function makeState(overrides: Partial<SidebarState> = {}): SidebarState {
	return {
		enabled: true,
		gitDetail: false,
		fullHeight: false,
		git: DEFAULT_GIT,
		turnCount: 0,
		isStreaming: false,
		getThinkingLevel: () => "off",
		...overrides,
	};
}

const theme = {
	fg: (_name: string, s: string) => s,
	bold: (s: string) => s,
} as unknown as Theme;

interface MockTerminal {
	columns: number;
	rows: number;
	writes: string[];
	write(data: string): void;
}

function makeTerminal(columns = 160, rows = 24): MockTerminal {
	return {
		columns,
		rows,
		writes: [],
		write(data) {
			this.writes.push(data);
		},
	};
}

/**
 * Mock TUI whose doRender mimics Pi's render: writes a synchronized-output
 * block with a `\r\n` scroll, then a cursor-move after the sync block (like
 * positionHardwareCursor).
 */
function makeTui(terminal: MockTerminal): {
	doRender: () => void;
	stopped: boolean;
	terminal: MockTerminal;
} {
	return {
		stopped: false,
		terminal,
		doRender() {
			terminal.write("\x1b[?2026hmain content\r\nmore\x1b[?2026l");
			terminal.write("\x1b[5;1H");
		},
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTui = any;

describe("SidebarCompositor doRender merge", () => {
	it("folds sidebar paint into a single write with one sync block", () => {
		const terminal = makeTerminal();
		const tui = makeTui(terminal);
		const state = makeState();
		const compositor = new SidebarCompositor(
			tui as AnyTui,
			() => state,
			() => undefined,
			theme,
		);
		compositor.install();

		expect(terminal.writes.length).toBe(0);

		tui.doRender();

		// The hook must collapse doRender + paint into exactly one write.
		expect(terminal.writes.length).toBe(1);
		const out = terminal.writes[0];

		// doRender's main content survives.
		expect(out).toContain("main content");
		// positionHardwareCursor's cursor move survives (outside sync, before paint).
		expect(out).toContain("\x1b[5;1H");
		// Sidebar separator (row 1 uses the heavy bar \u2503).
		expect(out).toContain("\u2503");
		// Exactly one sync-begin and one sync-end (not duplicated).
		expect(out.split("\x1b[?2026h").length - 1).toBe(1);
		expect(out.split("\x1b[?2026l").length - 1).toBe(1);
		// Sync end is the very last sequence.
		expect(out.endsWith("\x1b[?2026l")).toBe(true);
	});

	it("produces no sidebar when terminal is too narrow", () => {
		const terminal = makeTerminal(80, 24);
		const tui = makeTui(terminal);
		const state = makeState();
		const compositor = new SidebarCompositor(
			tui as AnyTui,
			() => state,
			() => undefined,
			theme,
		);
		compositor.install();
		tui.doRender();

		const out = terminal.writes[0];
		expect(out).not.toContain("\u2503");
	});

	it("wipes the sidebar region when disabled", () => {
		const terminal = makeTerminal();
		const tui = makeTui(terminal);
		const state = makeState({ enabled: false });
		const compositor = new SidebarCompositor(
			tui as AnyTui,
			() => state,
			() => undefined,
			theme,
		);
		compositor.install();
		tui.doRender();

		const out = terminal.writes[0];
		// No heavy separator when disabled; just spaces wiping the region.
		expect(out).not.toContain("\u2503");
		// Wipe resets bg color with \x1b[0m and fills with spaces.
		expect(out).toContain("\x1b[0m");
	});

	it("dispose restores write, doRender, columns, and clears the sidebar", () => {
		const terminal = makeTerminal();
		const tui = makeTui(terminal);
		const state = makeState();
		const hookedDoRender = tui.doRender;
		const compositor = new SidebarCompositor(
			tui as AnyTui,
			() => state,
			() => undefined,
			theme,
		);
		compositor.install();
		// install replaced doRender with the hook.
		expect(tui.doRender).not.toBe(hookedDoRender);

		compositor.dispose();

		// Dispose emitted a clear: spaces + reset, no separator.
		const clearOut = terminal.writes[terminal.writes.length - 1];
		expect(clearOut).toContain("\x1b[0m");
		expect(clearOut).not.toContain("\u2503");
		// columns restored to raw 160.
		expect(terminal.columns).toBe(160);
		// terminal.write is back to pushing onto writes (no capture).
		const before = terminal.writes.length;
		terminal.write("x");
		expect(terminal.writes.length).toBe(before + 1);

		// After dispose, calling doRender runs the original (no sidebar paint):
		// it produces the original's two chunks and no separator.
		const writesBefore = terminal.writes.length;
		tui.doRender();
		const newWrites = terminal.writes.slice(writesBefore);
		expect(newWrites.length).toBe(2);
		expect(newWrites.join("")).not.toContain("\u2503");
	});
});
