import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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
const BG_RESET = "\x1b[49m";
const RESET_FG = "\x1b[39m";
// ponytail: cap context refresh at 4 Hz; raise only if sidebar precision improves.
const CONTEXT_USAGE_CACHE_MS = 250;

// Use opencode sidebar's textMuted color (#808080 / rgb(128,128,128))
// for both dim and muted levels so secondary text is readable.
const SIDEBAR_GRAY = "\x1b[38;2;128;128;128m";

type PaintSnapshot = {
	key: string;
	rawCols: number;
	rawRows: number;
	state: SidebarState;
	ctx: ExtensionContext | undefined;
	contextUsage: ContextUsage | undefined;
	stopped: boolean;
};

type PaintResult = {
	content: string;
	changed: boolean;
};

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
	private paintCache: { key: string; content: string } | undefined;
	private contextUsageCache:
		| { key: string; at: number; value: ContextUsage | undefined }
		| undefined;

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

		// Hook tui.doRender so the sidebar is painted in the same synchronized
		// output block as Pi. The sidebar is outside Pi's line diff, so it only
		// needs a repaint when its content changes or the viewport actually scrolls.
		const tuiAny = this.tui as unknown as { doRender?: () => void };
		if (typeof tuiAny.doRender === "function" && typeof this.terminal.write === "function") {
			this.originalWrite = this.terminal.write.bind(this.terminal);
			this.originalDoRender = tuiAny.doRender.bind(tuiAny);
			const origWrite = this.originalWrite;
			const SYNC_BEGIN = "\x1b[?2026h";
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

				const previousViewportTop = self.getViewportTop();
				capturing = true;
				captured = [];
				syncRemoved = false;
				let renderError: unknown;
				try {
					self.originalDoRender!();
				} catch (error) {
					renderError = error;
				} finally {
					capturing = false;
				}

				const body = captured.join("");
				captured = [];
				if (renderError !== undefined) throw renderError;

				const snapshot = self.getPaintSnapshot();
				const paint = self.getPaintContent(snapshot);
				const shouldClearBeforeScroll =
					self.didScroll(previousViewportTop) &&
					!body.includes("\x1b[2J");
				const clear = shouldClearBeforeScroll
					? self.buildSidebarRegionClear(snapshot.rawCols, snapshot.rawRows)
					: "";
				const outputBody = clear
					? self.insertAfterSyncBegin(body, clear, SYNC_BEGIN)
					: body;
				const terminator = syncRemoved ? SYNC_END : "";
				origWrite(outputBody + (paint.changed ? paint.content : "") + terminator);
			};
		}
	}

	private getViewportTop(): number | undefined {
		const value = (this.tui as unknown as { previousViewportTop?: unknown })
			.previousViewportTop;
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	}

	private didScroll(previousViewportTop: number | undefined): boolean {
		const currentViewportTop = this.getViewportTop();
		return (
			previousViewportTop !== undefined &&
			currentViewportTop !== undefined &&
			currentViewportTop > previousViewportTop
		);
	}

	private insertAfterSyncBegin(body: string, content: string, syncBegin: string): string {
		const index = body.indexOf(syncBegin);
		if (index === -1) return content + body;
		const insertAt = index + syncBegin.length;
		return body.slice(0, insertAt) + content + body.slice(insertAt);
	}

	private getPaintSnapshot(): PaintSnapshot {
		const state = this.getState();
		const rawCols = this.getRawColumns();
		const rawRows = this.terminal.rows ?? process.stdout.rows ?? 24;
		const tuiState = this.tui as unknown as { stopped?: unknown };
		const stopped = tuiState.stopped === true;
		const ctx = this.getCtx();
		const manager = ctx?.sessionManager as unknown as {
			getLeafId?: () => string | null;
			getSessionName?: () => string | undefined;
			sessionFile?: string;
		} | undefined;
		const git = state.git;
		const gitFiles = git.files
			.slice(0, 12)
			.map((file) => `${file.code}:${file.path}:${file.delta ?? ""}`)
			.join("|");
		const model = ctx?.model;
		const contextCacheKey = [
			state.turnCount,
			state.isStreaming,
			ctx?.cwd ?? "",
			manager?.sessionFile ?? "",
			manager?.getLeafId?.() ?? "",
			model?.provider ?? "",
			model?.id ?? "",
		].join("\x1f");
		const now = Date.now();
		let contextUsage: ContextUsage | undefined;
		if (state.enabled) {
			const cached = this.contextUsageCache;
			if (cached && cached.key === contextCacheKey && now - cached.at < CONTEXT_USAGE_CACHE_MS) {
				contextUsage = cached.value;
			} else {
				contextUsage = ctx?.getContextUsage?.();
				this.contextUsageCache = { key: contextCacheKey, at: now, value: contextUsage };
			}
		}
		const thinkingLevel = state.enabled ? state.getThinkingLevel() : "";
		const key = [
			rawCols,
			rawRows,
			stopped,
			state.enabled,
			state.gitDetail,
			state.turnCount,
			state.isStreaming,
			state.lastTool ?? "",
			state.panelsCompact === true,
			git.insideRepo,
			git.error ?? "",
			git.branch ?? "",
			git.insertions,
			git.deletions,
			git.changedFiles,
			git.files.length,
			gitFiles,
			ctx?.cwd ?? "",
			manager?.sessionFile ?? "",
			manager?.getSessionName?.() ?? "",
			manager?.getLeafId?.() ?? "",
			model?.provider ?? "",
			model?.id ?? "",
			model?.name ?? "",
			model?.reasoning ?? false,
			thinkingLevel,
			contextUsage?.tokens ?? "",
			contextUsage?.contextWindow ?? "",
			contextUsage?.percent ?? "",
		].join("\x1f");
		return { key, rawCols, rawRows, state, ctx, contextUsage, stopped };
	}

	private getPaintContent(snapshot: PaintSnapshot): PaintResult {
		if (this.paintCache?.key === snapshot.key) {
			return { content: this.paintCache.content, changed: false };
		}
		const content = this.buildPaintContent(snapshot);
		this.paintCache = { key: snapshot.key, content };
		return { content, changed: true };
	}

	/**
	 * Clear the complete sidebar region once before a real scroll. Clearing the
	 * region up front prevents every scrolled row from carrying sidebar cells
	 * into scrollback, without rewriting every ordinary line break.
	 */
	private buildSidebarRegionClear(rawCols: number, rawRows: number): string {
		if (rawCols < MIN_TERMINAL_WIDTH) return "";
		const sepCol = rawCols - SIDEBAR_WIDTH;
		let buf = "\x1b7\x1b[?7l";
		for (let row = 1; row <= rawRows; row++) {
			buf += `\x1b[${row};${sepCol}H\x1b[0m`;
			buf += " ".repeat(SIDEBAR_WIDTH + 1);
		}
		return buf + "\x1b[?7h\x1b8";
	}

	paint(): void {
		const snapshot = this.getPaintSnapshot();
		const paint = this.getPaintContent(snapshot);
		if (!paint.content || !paint.changed) return;
		this.terminal.write("\x1b[?2026h" + paint.content + "\x1b[?2026l");
	}

	/**
	 * Build the sidebar paint buffer WITHOUT the synchronized-output wrapper.
	 * The caller (`paint` or the doRender hook) is responsible for wrapping
	 * this in `?2026h/l` so it can be merged with Pi's own sync block.
	 */
	private buildPaintContent(snapshot: PaintSnapshot): string {
		if (this.disposed || snapshot.stopped) return "";
		const { state, rawCols, rawRows, ctx, contextUsage } = snapshot;
		// Hide sidebar when terminal is too narrow
		if (rawCols < MIN_TERMINAL_WIDTH) return "";

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
			const buffer = 1;
			const contentWidth = Math.max(8, sw - buffer);
			const innerWidth = Math.max(8, contentWidth - 3);
			const lines = this.buildSidebarContent(ctx, state, innerWidth, rawRows, contextUsage);
			for (let row = 1; row <= rawRows; row++) {
				// Separator at the boundary between Pi content and sidebar
				buf += `\x1b[${row};${sepCol}H`;
				buf += this.theme.fg("border", row === 1 ? "\u2503" : "\u2502");
				// Sidebar background + content
				buf += `\x1b[${row};${sidebarCol}H`;
				buf += BG_RESET;
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
		contextUsage: ContextUsage | undefined,
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
			contextUsage,
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

			// Render bottom sections once, then use their length for budgeting.
			const bottomLines: string[] = [];
			const bottomAdd: typeof add = (line = "") => { bottomLines.push(line); };
			const bottomHeading: typeof heading = (label: string) => {
				bottomLines.push();
				bottomLines.push(this.theme.fg("text", this.theme.bold(label)));
			};
			const bottomSection = makeSection(bottomAdd, bottomHeading);
			renderGitSection(bottomSection);
			renderLocationSection(bottomSection);
			renderHintSection(bottomSection);

			// Budget for panels
			let panelBudget = rawRows - topLines - bottomLines.length;

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
			for (const line of bottomLines) add(line);
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
		// Columns are restored above, so use the raw terminal width here.
		const clearBuf = this.buildSidebarRegionClear(
			this.originalColumnsDesc ? this.getRawColumns() : this.terminal.columns,
			this.terminal.rows ?? process.stdout.rows ?? 24,
		);
		if (clearBuf) {
			this.terminal.write("\x1b[?2026h" + clearBuf + "\x1b[?2026l");
		}
	}
}
