import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	Theme,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
	GitState,
	SidebarState,
} from "./sidebar/types.js";
import {
	envBool,
	envInt,
	envSignedInt,
	padAnsi,
	parseNumstat,
	parseShortstat,
} from "./sidebar/utils.js";
import { SidebarCompositor } from "./sidebar/compositor.js";

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
} from "./sidebar/utils.js";

const DEFAULT_GIT: GitState = {
	insideRepo: false,
	files: [],
	insertions: 0,
	deletions: 0,
	changedFiles: 0,
};

export function piTitle(ctx: ExtensionContext): string {
	const sessionName = (
		ctx.sessionManager as unknown as {
			getSessionName?: () => string | undefined;
		}
	).getSessionName?.();
	return sessionName ?? "Pi Session";
}

export default function sidebarPlugin(pi: ExtensionAPI) {
	const refreshMs = envInt("PI_SIDEBAR_REFRESH_MS", 5000);
	const maxFiles = envInt(
		"PI_SIDEBAR_GIT_LINES",
		envInt("PI_SIDEBAR_MAX_FILES", 12),
	);

	const state: SidebarState = {
		enabled: envBool("PI_SIDEBAR_ENABLED", true),
		gitDetail: envBool("PI_SIDEBAR_GIT_DETAIL", true),
		fullHeight: envBool("PI_SIDEBAR_FULL_HEIGHT", false),
		git: DEFAULT_GIT,
		turnCount: 0,
		isStreaming: false,
		panelsCompact: false,
		getThinkingLevel: () => String(pi.getThinkingLevel?.() ?? "off"),
	};

	let currentCtx: ExtensionContext | undefined;
	let compositorRef: SidebarCompositor | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;

	function requestRender() {
		if (compositorRef) {
			compositorRef.paint();
		}
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

	function setupSidebar(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		currentCtx = ctx;
		void refreshGit(ctx);

		// Use setWidget to get access to Pi's TUI and theme.
		// The returned component is empty—the actual sidebar rendering is done
		// by SidebarCompositor via direct ANSI writes after every Pi render cycle.
		const factory = (_tui: TUI, theme: Theme): Component & { dispose?(): void } => {
			compositorRef = new SidebarCompositor(
				_tui,
				() => state,
				() => currentCtx,
				theme,
			);
			compositorRef.install();

			refreshTimer = setInterval(() => void refreshGit(), refreshMs);

			return {
				dispose() {
					if (refreshTimer) {
						clearInterval(refreshTimer);
						refreshTimer = undefined;
					}
					compositorRef?.dispose();
					compositorRef = undefined;
					process.stdout.write("\x1b[?25h");
				},
				invalidate() {},
				render(_width: number): string[] { return []; },
			};
		};

		ctx.ui.setWidget("pi-sidebar", factory, { placement: "belowEditor" });
	}

	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			currentCtx = ctx;
			setupSidebar(ctx);
		},
	);

	pi.on(
		"session_shutdown",
		async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
			process.stdout.write("\x1b[?25h");
		},
	);

	pi.on("turn_start", async (_event: TurnStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.turnCount++;
		state.isStreaming = true;
		requestRender();
	});

	pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.isStreaming = false;
		void refreshGit(ctx);
		requestRender();
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
			"Toggle or configure the pi sidebar: /sidebar [on|off|toggle|status|full|floating]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			setupSidebar(ctx);
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "on") state.enabled = true;
			else if (action === "off") state.enabled = false;
			else if (action === "full" || action === "full-height")
				state.fullHeight = true;
			else if (action === "floating" || action === "window")
				state.fullHeight = false;
			else if (action === "status") {
				ctx.ui.notify(
					`Sidebar is ${state.enabled ? "on" : "off"}; layout is ${state.fullHeight ? "full-height" : "floating"}; git detail is ${state.gitDetail ? "on" : "off"}.`,
					"info",
				);
				return;
			} else state.enabled = !state.enabled;
			requestRender();
			ctx.ui.notify(`Sidebar ${state.enabled ? "enabled" : "hidden"}`, "info");
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

	pi.registerCommand("sidebar-panels", {
		description:
			"Toggle panels compact mode: /sidebar-panels [on|off]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = args.trim().toLowerCase();
			if (action === "on") state.panelsCompact = true;
			else if (action === "off") state.panelsCompact = false;
			else state.panelsCompact = !state.panelsCompact;
			requestRender();
			ctx.ui.notify(
				`Sidebar panels ${state.panelsCompact ? "compact" : "expanded"}`,
				"info",
			);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Toggle pi sidebar",
		handler: async (ctx: ExtensionContext) => {
			currentCtx = ctx;
			setupSidebar(ctx);
			state.enabled = !state.enabled;
			requestRender();
		},
	});
}
