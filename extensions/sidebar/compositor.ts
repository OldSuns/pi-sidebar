import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SidebarState } from "./types.ts";
import { renderModelSection } from "./sections/model.js";
import { renderSessionSection } from "./sections/session.js";
import { renderContextSection } from "./sections/context.js";
import { renderGitSection } from "./sections/git.js";
import { renderHintSection } from "./sections/hint.js";
import { renderLocationSection } from "./sections/location.js";
import { padAnsi } from "./utils.js";
import {
	loadSidebarUIConfig,
	renderExternalPanels,
	type SidebarUIConfig,
} from "./panels.js";

const SIDEBAR_WIDTH = 34;
/** Minimum terminal columns required to show the sidebar. Below this, the sidebar is hidden. */
const MIN_TERMINAL_WIDTH = 120;
const SIDEBAR_BG = "\x1b[48;2;0;0;0m";
const BG_RESET = "\x1b[49m";
const RESET_FG = "\x1b[39m";

// Use opencode sidebar's textMuted color (#808080 / rgb(128,128,128))
// for both dim and muted levels so secondary text is readable.
const SIDEBAR_GRAY = "\x1b[38;2;128;128;128m";

/**
 * SidebarCompositor renders a right-sidebar by shrinking `terminal.columns`
 * (so Pi renders content in the reduced width) then painting the sidebar
 * region via raw ANSI escape codes after every Pi render cycle.
 *
 * This avoids Pi TUI overlay overlap because Pi never draws in the reserved
 * right-side columns.
 */
export class SidebarCompositor {
	private tui: TUI;
	private terminal: {
		columns: number;
		rows: number;
		write: (data: string) => void;
	};
	private getState: () => SidebarState;
	private getCtx: () => ExtensionContext | undefined;
	private theme: Theme;
	private originalColumnsDesc: PropertyDescriptor | undefined;
	private originalDoRender: (() => void) | null = null;
	private originalWrite: ((data: string) => void) | null = null;
	private disposed = false;
	private panelConfig: SidebarUIConfig = {};


	constructor(
		tui: TUI,
		getState: () => SidebarState,
		getCtx: () => ExtensionContext | undefined,
		theme: Theme,
	) {
		this.tui = tui;
		// TUI's internal terminal object: reach it via the TUI instance cast.
		this.terminal = (
			tui as unknown as { terminal?: { columns: number; rows: number; write: (data: string) => void } }
		).terminal ?? (tui as unknown as { columns: number; rows: number; write: (data: string) => void });
		this.getState = getState;
		this.getCtx = getCtx;
		this.theme = theme;
	}

	install(): void {
		const self = this;

		// Shrink terminal.columns so Pi renders in the left portion
		this.originalColumnsDesc = this.describeProperty(this.terminal, "columns");
		const origDesc = this.originalColumnsDesc;
		const terminal = this.terminal;

		Object.defineProperty(terminal, "columns", {
			configurable: true,
			enumerable: true,
			get() {
				const d = origDesc;
				const raw = d?.get
					? (d.get.call(terminal) ?? 80)
					: typeof d?.value === "number"
						? d.value
						: 80;
				// When terminal is too narrow, restore full width (sidebar hidden)
				if (raw < MIN_TERMINAL_WIDTH) return raw;
				return Math.max(1, raw - SIDEBAR_WIDTH - 1);
			},
		});

		// Load external panel config from sidebar-ui.json
		const ctx = this.getCtx();
		this.panelConfig = loadSidebarUIConfig(ctx?.cwd);

		// Hook tui.doRender so we paint the sidebar after every Pi render.
		// We also wrap terminal.write so the sidebar paint is folded into Pi's
		// own synchronized-output (`?2026h/l`) block: doRender's `\r\n` scroll
		// would otherwise wipe the sidebar column, and a separate paint call
		// would land in its own sync block — the terminal refreshes between
		// them, so the sidebar visibly flickers on every render. By stripping
		// the `?2026l` terminator from doRender's output, appending the paint,
		// then re-emitting `?2026l`, the whole scroll+repaint is atomic to the
		// terminal and the sidebar appears fixed.
		const tuiAny = this.tui as unknown as { doRender?: () => void };
		if (typeof tuiAny.doRender === "function" && typeof this.terminal.write === "function") {
			this.originalWrite = this.terminal.write.bind(this.terminal);
			this.originalDoRender = tuiAny.doRender.bind(tuiAny);
			const origWrite = this.originalWrite;
			const SYNC_END = "\x1b[?2026l";
			let capturing = false;
			let captured: string[] = [];
			let syncRemoved = false;

			this.terminal.write = (data: string) => {
				if (capturing) {
					if (data.endsWith(SYNC_END)) {
						captured.push(data.slice(0, -SYNC_END.length));
						syncRemoved = true;
					} else {
						captured.push(data);
					}
				} else {
					origWrite(data);
				}
			};

			tuiAny.doRender = () => {
				if (self.disposed) {
					self.originalDoRender?.();
					return;
				}
				capturing = true;
				captured = [];
				syncRemoved = false;
				self.originalDoRender!();
				capturing = false;
				const paintContent = self.buildPaintContent();
				const terminator = syncRemoved ? SYNC_END : "";
				origWrite(captured.join("") + paintContent + terminator);
				captured = [];
			};
		}

		// Switch to the alternate screen buffer so the terminal has no
		// scrollback: mouse-wheel scrolling can't move the viewport backwards,
		// so the sidebar (repainted every render at a fixed screen position)
		// stays fixed even during wheel scroll. Pi renders into the alternate
		// buffer; on dispose we switch back to the primary buffer.
		this.terminal.write("\x1b[?1049h");
	}

	paint(): void {
		const content = this.buildPaintContent();
		if (!content) return;
		this.terminal.write("\x1b[?2026h" + content + "\x1b[?2026l");
	}

	/**
	 * Build the sidebar paint buffer WITHOUT the synchronized-output wrapper.
	 * The caller (`paint` or the doRender hook) is responsible for wrapping
	 * this in `?2026h/l` so it can be merged with Pi's own sync block.
	 */
	private buildPaintContent(): string {
		if (this.disposed) return "";
		// Skip painting while TUI is stopped (e.g. external editor active)
		// to avoid ANSI codes overwriting the editor's display.
		if ((this.tui as unknown as { stopped?: boolean }).stopped) return "";

		const state = this.getState();
		const rawCols = this.getRawColumns();
		// Hide sidebar when terminal is too narrow
		if (rawCols < MIN_TERMINAL_WIDTH) return "";

		const rawRows = this.terminal.rows ?? process.stdout.rows ?? 24;
		const sw = SIDEBAR_WIDTH;
		const sepCol = rawCols - sw;
		const sidebarCol = sepCol + 1;

		let buf = "\x1b7";          // save cursor (DECSC)
		buf += "\x1b[?7l";          // disable auto-wrap

		if (!state.enabled) {
			// Wipe separator + sidebar with spaces, resetting any bg color
			for (let row = 1; row <= rawRows; row++) {
				buf += `\x1b[${row};${sepCol}H\x1b[0m`;
				buf += " ".repeat(sw + 1);
			}
		} else {
			const ctx = this.getCtx();
			const buffer = 1;
			const contentWidth = Math.max(8, sw - buffer);
			const innerWidth = Math.max(8, contentWidth - 3);
			const lines = this.buildSidebarContent(ctx, state, innerWidth, rawRows);
			for (let row = 1; row <= rawRows; row++) {
				// Separator at the boundary between Pi content and sidebar
				buf += `\x1b[${row};${sepCol}H`;
				buf += this.theme.fg("border", row === 1 ? "\u2503" : "\u2502");
				// Sidebar background + content
				buf += `\x1b[${row};${sidebarCol}H`;
				buf += SIDEBAR_BG;
				const line = lines[row - 1];
				if (line !== undefined) {
					buf += truncateToWidth(line, sw, "", true);
				} else {
					buf += " ".repeat(sw);
				}
				buf += BG_RESET;
			}
		}

		buf += "\x1b[?7h";       // enable auto-wrap
		buf += "\x1b8";          // restore cursor (DECRC)
		return buf;
	}

	private getRawColumns(): number {
		const d = this.originalColumnsDesc;
		return d?.get
			? (d.get.call(this.terminal) ?? 80)
			: typeof d?.value === "number"
				? d.value
				: 80;
	}

	private buildSidebarContent(
		ctx: ExtensionContext | undefined,
		state: SidebarState,
		innerWidth: number,
		rawRows: number,
	): string[] {
		const lines: string[] = [];
		const fmtLine = (line: string) =>
			padAnsi(truncateToWidth(
				this.theme.fg("borderMuted", "\u2502 ") + line,
				SIDEBAR_WIDTH,
				"",
			), SIDEBAR_WIDTH);

		const add = (line = "") => { lines.push(fmtLine(line)); };
		const heading = (label: string) => {
			add();
			add(this.theme.fg("text", this.theme.bold(label)));
		};

		// Helper to build a section proxy with custom add/heading
		const makeSection = (a: typeof add, h: typeof heading) => ({
			ctx,
			state,
			theme: this.theme,
			innerWidth,
			add: a,
			heading: h,
			muted: (s: string) => `${SIDEBAR_GRAY}${s}${RESET_FG}`,
			dim: (s: string) => `${SIDEBAR_GRAY}${s}${RESET_FG}`,
			options: {
				maxFiles: 12,
				buffer: 1,
				fillRows: 200,
				getThinkingLevel: () => state.getThinkingLevel(),
			},
		});

		// ── Top fixed sections ──
		renderSessionSection(makeSection(add, heading));
		renderModelSection(makeSection(add, heading));
		renderContextSection(makeSection(add, heading));

		if (state.panelsCompact) {
			// ── Compact mode: budget panels so Git/Location/Hint always visible ──
			const topLines = lines.length;

			// Count bottom sections
			let bottomCount = 0;
			const countAdd: typeof add = () => { bottomCount++; };
			const countHeading: typeof heading = () => { bottomCount += 2; };
			const countSection = makeSection(countAdd, countHeading);
			renderGitSection(countSection);
			renderLocationSection(countSection);
			renderHintSection(countSection);

			// Budget for panels
			let panelBudget = rawRows - topLines - bottomCount;

			// Render panels within budget
			if (panelBudget > 0) {
				const panelAdd: typeof add = (line = "") => {
					if (panelBudget <= 0) return;
					panelBudget--;
					lines.push(fmtLine(line));
				};
				const panelHeading: typeof heading = (label: string) => {
					if (panelBudget < 2) return;
					panelAdd();
					panelAdd(this.theme.fg("text", this.theme.bold(label)));
				};
				renderExternalPanels(ctx, this.panelConfig, this.theme, innerWidth, panelAdd, panelHeading, {
					maxLines: 3,
				});
			}

			// Bottom sections always rendered
			renderGitSection(makeSection(add, heading));
			renderLocationSection(makeSection(add, heading));
			renderHintSection(makeSection(add, heading));
		} else {
			// ── Normal mode: render everything in order, no budget ──
			renderExternalPanels(ctx, this.panelConfig, this.theme, innerWidth, add, heading);
			renderGitSection(makeSection(add, heading));
			renderLocationSection(makeSection(add, heading));
			renderHintSection(makeSection(add, heading));
		}

		return lines;
	}

	private describeProperty(
		obj: object,
		key: string,
	): PropertyDescriptor | undefined {
		let target: object | null = obj;
		while (target) {
			const d = Object.getOwnPropertyDescriptor(target, key);
			if (d) return d;
			target = Object.getPrototypeOf(target);
		}
		return undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		// Restore the original columns descriptor
		if (this.originalColumnsDesc) {
			Object.defineProperty(this.terminal, "columns", this.originalColumnsDesc);
		} else {
			try { Reflect.deleteProperty(this.terminal, "columns"); } catch { /* ignore */ }
		}

		// Restore the original doRender
		if (this.originalDoRender !== null) {
			(this.tui as unknown as { doRender?: () => void }).doRender = this.originalDoRender;
			this.originalDoRender = null;
		}

		// Restore the original terminal.write before clearing so the clear
		// output goes straight to the terminal without capture interference.
		if (this.originalWrite !== null) {
			this.terminal.write = this.originalWrite;
			this.originalWrite = null;
		}

		// Clear the sidebar region so it doesn't linger on screen after exit.
		// Columns are restored above, so this.terminal.columns is the raw width.
		const clearBuf = this.buildClearContent();
		if (clearBuf) {
			this.terminal.write("\x1b[?2026h" + clearBuf + "\x1b[?2026l");
		}

		// Switch back to the primary screen buffer (matches the ?1049h in
		// install). Must come after the clear so the clear lands in the
		// alternate buffer, not the primary.
		this.terminal.write("\x1b[?1049l");
	}

	private buildClearContent(): string {
		const rawCols = this.terminal.columns;
		const rawRows = this.terminal.rows ?? process.stdout.rows ?? 24;
		if (rawCols < MIN_TERMINAL_WIDTH) return "";
		const sw = SIDEBAR_WIDTH;
		const sepCol = rawCols - sw;
		let buf = "\x1b7\x1b[?7l";
		for (let row = 1; row <= rawRows; row++) {
			// Overwrite separator + sidebar with spaces, resetting any bg color
			buf += `\x1b[${row};${sepCol}H\x1b[0m`;
			buf += " ".repeat(sw + 1);
		}
		buf += "\x1b[?7h\x1b8";
		return buf;
	}
}
