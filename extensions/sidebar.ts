import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	KeybindingsManager,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderContextSection } from "./sidebar/sections/context.js";
import { renderGitSection } from "./sidebar/sections/git.js";
import { renderHintSection } from "./sidebar/sections/hint.js";
import { renderLocationSection } from "./sidebar/sections/location.js";
import { renderModelSection } from "./sidebar/sections/model.js";
import type {
	GitState,
	SidebarRenderOptions,
	SidebarSectionContext,
	SidebarState,
	Theme,
} from "./sidebar/types.js";
import {
	envBool,
	envInt,
	envSignedInt,
	padAnsi,
	parseNumstat,
	parseShortstat,
	shouldHideSidebar,
} from "./sidebar/utils.js";

export type { GitState, SidebarState } from "./sidebar/types.js";
export {
	envBool,
	envInt,
	envSignedInt,
	formatFileLine,
	fmtNumber,
	padAnsi,
	parseNumstat,
	parseShortstat,
	shouldHideSidebar,
} from "./sidebar/utils.js";

const DEFAULT_GIT: GitState = {
	insideRepo: false,
	files: [],
	insertions: 0,
	deletions: 0,
	changedFiles: 0,
};

const SIDEBAR_SECTIONS: Array<(section: SidebarSectionContext) => void> = [
	renderModelSection,
	renderContextSection,
	renderGitSection,
	renderLocationSection,
	renderHintSection,
];

export function setSidebarCollapsed(
	state: Pick<SidebarState, "enabled" | "collapsed">,
	collapsed: boolean,
): void {
	state.enabled = true;
	state.collapsed = collapsed;
}

export function toggleSidebarCollapsed(
	state: Pick<SidebarState, "enabled" | "collapsed">,
): void {
	if (!state.enabled) {
		setSidebarCollapsed(state, false);
		return;
	}
	setSidebarCollapsed(state, !state.collapsed);
}

export class SidebarComponent implements Component {
	constructor(
		private readonly getContext: () => ExtensionContext | undefined,
		private readonly state: SidebarState,
		private readonly theme: Theme,
		private readonly options: SidebarRenderOptions,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.state.collapsed) return this.renderCollapsed(width);

		const ctx = this.getContext();
		const buffer = this.state.fullHeight ? this.options.buffer : 0;
		const contentWidth = Math.max(8, width - buffer);
		const innerWidth = Math.max(8, contentWidth - 3);
		const lines: string[] = [];
		const add = (line = "") => {
			const gutter = buffer > 0 ? " ".repeat(buffer) : "";
			const bordered = gutter + this.theme.fg("borderMuted", "│ ") + line;
			lines.push(padAnsi(truncateToWidth(bordered, width, ""), width));
		};
		const heading = (label: string) => {
			add();
			add(this.theme.fg("text", this.theme.bold(label)));
		};
		const section: SidebarSectionContext = {
			ctx,
			state: this.state,
			theme: this.theme,
			innerWidth,
			add,
			heading,
			muted: (s: string) => this.theme.fg("muted", s),
			dim: (s: string) => this.theme.fg("dim", s),
			options: this.options,
		};

		const verticalPadding = this.state.fullHeight
			? 0
			: this.options.verticalPadding;
		for (let i = 0; i < verticalPadding; i++) add();
		for (const renderSection of SIDEBAR_SECTIONS) renderSection(section);
		for (let i = 0; i < verticalPadding; i++) add();
		if (this.state.fullHeight) {
			while (lines.length < this.options.fillRows) add();
		}
		return lines;
	}

	private renderCollapsed(width: number): string[] {
		const rail = (label = "") => {
			const markerText = label ? "◀│" : " │";
			const marker = this.theme.fg(
				label ? "accent" : "borderMuted",
				markerText,
			);
			const line = " ".repeat(Math.max(0, width - markerText.length)) + marker;
			return padAnsi(truncateToWidth(line, width, ""), width);
		};
		if (this.state.fullHeight) {
			const lines = Array.from({ length: this.options.fillRows }, () => rail());
			if (lines.length > 1) lines[1] = rail("restore");
			return lines;
		}
		return [rail(), rail("restore"), rail()];
	}
}

export function piTitle(ctx: ExtensionContext): string {
	const sessionName = (
		ctx.sessionManager as unknown as {
			getSessionName?: () => string | undefined;
		}
	).getSessionName?.();
	return sessionName ?? "Pi Session";
}

export default function sidebarPlugin(pi: ExtensionAPI) {
	const sidebarWidth = envInt("PI_SIDEBAR_WIDTH", 34);
	const sidebarBuffer = envInt("PI_SIDEBAR_BUFFER", 1);
	const sidebarFillRows = envInt("PI_SIDEBAR_FILL_ROWS", 200);
	const sidebarVerticalPadding = Math.max(
		0,
		envSignedInt("PI_SIDEBAR_VERTICAL_PADDING", 1),
	);
	const minTermWidth = envInt("PI_SIDEBAR_MIN_TERM_WIDTH", 110);
	const refreshMs = envInt("PI_SIDEBAR_REFRESH_MS", 5000);
	const maxFiles = envInt(
		"PI_SIDEBAR_GIT_LINES",
		envInt("PI_SIDEBAR_MAX_FILES", 12),
	);
	const autohideWorking = envBool("PI_SIDEBAR_AUTOHIDE_WORKING", true);
	const floatingOffsetY = envSignedInt("PI_SIDEBAR_OFFSET_Y", -6);

	const state: SidebarState = {
		enabled: envBool("PI_SIDEBAR_ENABLED", true),
		collapsed: false,
		gitDetail: envBool("PI_SIDEBAR_GIT_DETAIL", true),
		fullHeight: envBool("PI_SIDEBAR_FULL_HEIGHT", false),
		git: DEFAULT_GIT,
		turnCount: 0,
		isStreaming: false,
	};

	let currentCtx: ExtensionContext | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let component: SidebarComponent | undefined;
	let tuiRef: TUI | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;

	function requestRender() {
		component?.invalidate();
		tuiRef?.requestRender();
	}

	function applyVisibility() {
		overlayHandle?.setHidden(shouldHideSidebar(state, autohideWorking));
		requestRender();
	}

	function sidebarOverlayWidth(): number {
		return sidebarWidth + (state.fullHeight ? sidebarBuffer : 0);
	}

	async function refreshGit(ctx: ExtensionContext | undefined = currentCtx) {
		if (!ctx || refreshing) return;
		refreshing = true;
		try {
			const inside = await pi.exec(
				"git",
				["rev-parse", "--is-inside-work-tree"],
				{ cwd: ctx.cwd, timeout: 1500 },
			);
			if (inside.code !== 0 || inside.stdout.trim() !== "true") {
				state.git = { ...DEFAULT_GIT, error: "not a git repo" };
				return;
			}

			const [branchRes, statRes, statusRes, numstatRes] = await Promise.all([
				pi.exec("git", ["branch", "--show-current"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
				pi.exec("git", ["diff", "--shortstat"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
				pi.exec("git", ["status", "--porcelain=v1"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
				pi.exec("git", ["diff", "--numstat", "HEAD", "--"], {
					cwd: ctx.cwd,
					timeout: 1500,
				}),
			]);

			let branch = branchRes.stdout.trim();
			if (!branch) {
				const head = await pi.exec("git", ["rev-parse", "--short", "HEAD"], {
					cwd: ctx.cwd,
					timeout: 1500,
				});
				branch = head.stdout.trim();
			}

			const deltas = parseNumstat(
				numstatRes.code === 0 ? numstatRes.stdout : "",
			);
			const files = statusRes.stdout
				.split("\n")
				.map((line: string) => line.trimEnd())
				.filter(Boolean)
				.map((line: string) => {
					const code = line.slice(0, 2).trim() || "M";
					const path = line.slice(3).trim();
					return {
						code,
						path,
						delta: deltas.get(path) ?? (code.includes("?") ? "new" : undefined),
					};
				});

			const stats = parseShortstat(statRes.stdout.trim());
			state.git = {
				insideRepo: true,
				branch,
				files,
				changedFiles: stats.changedFiles || files.length,
				insertions: stats.insertions,
				deletions: stats.deletions,
			};
			state.lastGitRefresh = Date.now();
		} catch (error) {
			state.git = {
				...DEFAULT_GIT,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			refreshing = false;
			requestRender();
		}
	}

	function startSidebar(ctx: ExtensionContext) {
		if (!ctx.hasUI || component) return;
		currentCtx = ctx;
		void refreshGit(ctx);
		void ctx.ui.custom<void>(
			(
				tui: TUI,
				theme: Theme,
				_keybindings: KeybindingsManager,
				done: (result: void) => void,
			) => {
				tuiRef = tui;
				component = new SidebarComponent(() => currentCtx, state, theme, {
					maxFiles,
					buffer: sidebarBuffer,
					fillRows: sidebarFillRows,
					verticalPadding: sidebarVerticalPadding,
					getThinkingLevel: () => pi.getThinkingLevel?.(),
				});
				refreshTimer = setInterval(() => void refreshGit(), refreshMs);
				return {
					dispose() {
						if (refreshTimer) clearInterval(refreshTimer);
						refreshTimer = undefined;
						component = undefined;
						tuiRef = undefined;
						done();
					},
					render: (width: number) => component?.render(width) ?? [],
					invalidate: () => component?.invalidate(),
				};
			},
			{
				overlay: true,
				overlayOptions: () => ({
					anchor: state.fullHeight ? "top-right" : "right-center",
					width: sidebarOverlayWidth(),
					maxHeight: "100%",
					margin: state.fullHeight
						? { top: 0, right: 0, bottom: 0 }
						: { right: 0 },
					offsetY: state.fullHeight ? 0 : floatingOffsetY,
					nonCapturing: true,
					visible: (termWidth: number) => termWidth >= minTermWidth,
				}),
				onHandle: (handle: OverlayHandle) => {
					overlayHandle = handle;
					handle.unfocus();
					applyVisibility();
				},
			},
		);
	}

	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
		},
	);

	pi.on(
		"session_shutdown",
		async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
			overlayHandle?.hide();
			overlayHandle = undefined;
		},
	);

	pi.on("turn_start", async (_event: TurnStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.turnCount++;
		state.isStreaming = true;
		applyVisibility();
	});

	pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.isStreaming = false;
		void refreshGit(ctx);
		applyVisibility();
	});

	pi.on(
		"tool_execution_start",
		async (event: { toolName: string }, ctx: ExtensionContext) => {
			currentCtx = ctx;
			state.lastTool = event.toolName;
			requestRender();
		},
	);

	pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
		currentCtx = ctx;
		requestRender();
	});

	pi.registerCommand("sidebar", {
		description:
			"Toggle or configure the pi sidebar: /sidebar [collapse|expand|on|off|status|full|floating]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "on") setSidebarCollapsed(state, false);
			else if (action === "off") state.enabled = false;
			else if (action === "collapse" || action === "collapsed")
				setSidebarCollapsed(state, true);
			else if (action === "expand" || action === "expanded")
				setSidebarCollapsed(state, false);
			else if (action === "full" || action === "full-height")
				state.fullHeight = true;
			else if (action === "floating" || action === "window")
				state.fullHeight = false;
			else if (action === "status") {
				ctx.ui.notify(
					`Sidebar is ${state.enabled ? "on" : "off"}; ${state.collapsed ? "collapsed" : "expanded"}; layout is ${state.fullHeight ? "full-height" : "floating"}; autohide while working is ${autohideWorking ? "on" : "off"}; git detail is ${state.gitDetail ? "on" : "off"}.`,
					"info",
				);
				return;
			} else if (action === "toggle") toggleSidebarCollapsed(state);
			else {
				ctx.ui.notify(`Unknown sidebar option: ${action}`, "warning");
				return;
			}
			applyVisibility();
			ctx.ui.notify(
				`Sidebar ${state.enabled ? (state.collapsed ? "collapsed" : "enabled") : "hidden"}`,
				"info",
			);
		},
	});

	pi.registerCommand("sidebar-refresh", {
		description: "Refresh sidebar git/status data",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			await refreshGit(ctx);
			ctx.ui.notify("Sidebar refreshed", "info");
		},
	});

	pi.registerCommand("sidebar-git-detail", {
		description: "Toggle detailed changed-file list in the sidebar",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			state.gitDetail = !state.gitDetail;
			requestRender();
			ctx.ui.notify(
				`Sidebar git detail ${state.gitDetail ? "enabled" : "reduced"}`,
				"info",
			);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Collapse or expand pi sidebar",
		handler: async (ctx: ExtensionContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
			toggleSidebarCollapsed(state);
			applyVisibility();
		},
	});
}
