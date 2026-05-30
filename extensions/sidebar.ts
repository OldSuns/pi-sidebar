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
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

export type GitState = {
	insideRepo: boolean;
	branch?: string;
	files: Array<{ code: string; path: string; delta?: string }>;
	insertions: number;
	deletions: number;
	changedFiles: number;
	error?: string;
};

export type SidebarState = {
	enabled: boolean;
	gitDetail: boolean;
	fullHeight: boolean;
	git: GitState;
	lastGitRefresh?: number;
	turnCount: number;
	isStreaming: boolean;
	lastTool?: string;
};

const DEFAULT_GIT: GitState = {
	insideRepo: false,
	files: [],
	insertions: 0,
	deletions: 0,
	changedFiles: 0,
};

export function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function envSignedInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

export function fmtNumber(n: number): string {
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function padAnsi(line: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(line));
	return line + " ".repeat(pad);
}

export function parseShortstat(
	shortstat: string,
): Pick<GitState, "changedFiles" | "insertions" | "deletions"> {
	const changedFiles = Number(
		shortstat.match(/(\d+) files? changed/)?.[1] ?? 0,
	);
	const insertions = Number(shortstat.match(/(\d+) insertions?/)?.[1] ?? 0);
	const deletions = Number(shortstat.match(/(\d+) deletions?/)?.[1] ?? 0);
	return { changedFiles, insertions, deletions };
}

export function parseNumstat(numstat: string): Map<string, string> {
	const deltas = new Map<string, string>();
	for (const line of numstat.split("\n")) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;
		const [added, deleted, ...pathParts] = trimmed.split("\t");
		const path = pathParts.join("\t").trim();
		if (!path) continue;
		const addedText = added === "-" ? "bin" : `+${added}`;
		const deletedText = deleted === "-" ? "bin" : `-${deleted}`;
		deltas.set(
			path,
			addedText === "bin" || deletedText === "bin"
				? "bin"
				: `${addedText}/${deletedText}`,
		);
	}
	return deltas;
}

export function shouldHideSidebar(
	state: Pick<SidebarState, "enabled" | "isStreaming">,
	autohideWorking: boolean,
): boolean {
	return !state.enabled || (autohideWorking && state.isStreaming);
}

export function formatFileLine(
	file: { code: string; path: string; delta?: string },
	width: number,
): string {
	const code = file.code.padEnd(2);
	const delta = file.delta ? ` ${file.delta}` : "";
	const pathWidth = Math.max(
		1,
		width - visibleWidth(code) - visibleWidth(delta) - 1,
	);
	return `${code} ${truncateToWidth(file.path, pathWidth, "…")}${delta}`;
}

function colorDelta(delta: string | undefined, theme: Theme): string {
	if (!delta) return "";
	const numeric = delta.match(/^(\+\d+)\/(-\d+)$/);
	if (numeric) {
		return `${theme.fg("toolDiffAdded", numeric[1])}${theme.fg("dim", "/")}${theme.fg("toolDiffRemoved", numeric[2])}`;
	}
	return theme.fg(delta === "new" ? "toolDiffAdded" : "dim", delta);
}

export class SidebarComponent implements Component {
	constructor(
		private readonly getContext: () => ExtensionContext | undefined,
		private readonly state: SidebarState,
		private readonly theme: Theme,
		private readonly options: {
			maxFiles: number;
			buffer: number;
			fillRows: number;
			getThinkingLevel: () => string | undefined;
		},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
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
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);

		add(this.theme.fg("text", this.theme.bold("Model")));
		const reasoning = this.options.getThinkingLevel() ?? "off";
		if (ctx?.model) {
			add(truncateToWidth(`${ctx.model.id} • ${reasoning}`, innerWidth, "…"));
			add(dim(truncateToWidth(ctx.model.provider, innerWidth, "…")));
		} else {
			add(dim(`no model • ${reasoning}`));
		}
		add(
			dim(
				`turns ${this.state.turnCount}${this.state.isStreaming ? " • streaming" : ""}`,
			),
		);
		if (this.state.lastTool) add(dim(`last tool ${this.state.lastTool}`));

		heading("Context");
		const usage = ctx?.getContextUsage();
		if (usage) {
			const tokenText =
				usage.tokens == null ? "unknown" : fmtNumber(usage.tokens);
			const percentText =
				usage.percent == null ? "?" : `${usage.percent.toFixed(0)}%`;
			add(`${percentText} • ${tokenText} of ${fmtNumber(usage.contextWindow)}`);
		} else {
			add(muted("not available yet"));
		}

		heading("Git");
		this.renderGit(add, innerWidth);

		heading("Location");
		add(dim(truncateToWidth(ctx?.cwd ?? process.cwd(), innerWidth, "…")));

		add();
		add(dim("/sidebar status"));
		if (this.state.fullHeight) {
			while (lines.length < this.options.fillRows) add();
		}
		return lines;
	}

	private renderGit(add: (line?: string) => void, width: number): void {
		const git = this.state.git;
		if (!git.insideRepo) {
			add(
				this.theme.fg(
					git.error ? "warning" : "muted",
					git.error ?? "not a git repo",
				),
			);
			return;
		}

		if (git.branch)
			add(this.theme.fg("accent", truncateToWidth(git.branch, width, "…")));
		const summary = `${git.changedFiles} files  ${this.theme.fg("toolDiffAdded", `+${git.insertions}`)} ${this.theme.fg("toolDiffRemoved", `-${git.deletions}`)}`;
		add(summary);

		if (git.files.length === 0) {
			add(this.theme.fg("success", "clean working tree"));
			return;
		}

		const max = this.state.gitDetail
			? this.options.maxFiles
			: Math.min(5, this.options.maxFiles);
		for (const file of git.files.slice(0, max)) {
			const codeColor = file.code.includes("D")
				? "toolDiffRemoved"
				: file.code.includes("A") || file.code.includes("?")
					? "toolDiffAdded"
					: "warning";
			const code = file.code.padEnd(2);
			const delta = file.delta ? ` ${file.delta}` : "";
			const pathWidth = Math.max(
				1,
				width - visibleWidth(code) - visibleWidth(delta) - 1,
			);
			const path = truncateToWidth(file.path, pathWidth, "…");
			const coloredDelta = colorDelta(file.delta, this.theme);
			add(
				`${this.theme.fg(codeColor, code)} ${path}${coloredDelta ? ` ${coloredDelta}` : ""}`,
			);
		}
		if (git.files.length > max)
			add(this.theme.fg("dim", `…${git.files.length - max} more`));
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
			"Toggle or configure the pi sidebar: /sidebar [on|off|toggle|status|full|floating]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "on") state.enabled = true;
			else if (action === "off") state.enabled = false;
			else if (action === "full" || action === "full-height")
				state.fullHeight = true;
			else if (action === "floating" || action === "window")
				state.fullHeight = false;
			else if (action === "status") {
				ctx.ui.notify(
					`Sidebar is ${state.enabled ? "on" : "off"}; layout is ${state.fullHeight ? "full-height" : "floating"}; autohide while working is ${autohideWorking ? "on" : "off"}; git detail is ${state.gitDetail ? "on" : "off"}.`,
					"info",
				);
				return;
			} else state.enabled = !state.enabled;
			applyVisibility();
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

	pi.registerShortcut("ctrl+shift+s", {
		description: "Toggle pi sidebar",
		handler: async (ctx: ExtensionContext) => {
			currentCtx = ctx;
			startSidebar(ctx);
			state.enabled = !state.enabled;
			applyVisibility();
		},
	});
}
