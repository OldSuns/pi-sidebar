import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SidebarActions } from "./commands.ts";
import {
  BODY_PANELS,
  type BodyPanel,
  changedSettings,
  type ColorMode,
  defaultConfig,
  type IconMode,
  loadConfig,
  PANEL_NAMES,
  type PanelName,
  type SidebarConfig,
  saveConfig,
} from "./config.ts";
import { GitMonitor } from "./git/monitor.ts";
import { type LayoutSettings, LayoutHost, tuiPort } from "./host/layout-host.ts";
import { STEP_UP_MARGIN, type SidebarWidth, type WidthSetting } from "./layout/width.ts";
import {
  endRun,
  endTool,
  firstToken,
  responseDone,
  startRun,
  startTool,
  startTurn,
  streamingSpeed,
  type ToolEnd,
  type ToolStart,
  tokensPerSecond,
} from "./state/activity.ts";
import {
  compositionFromRequest,
  compositionFromSession,
  type EstimateMessage,
  estimateText,
  messageTokens,
  toolTokens,
} from "./state/composition.ts";
import { readContext } from "./state/context.ts";
import {
  type AgentFlags,
  idleFlags,
  lastActivity,
  type RunOutcome,
  readBilling,
  readModel,
  sessionName,
  statusOf,
} from "./state/session.ts";
import { emptySnapshot, type GitState, type SidebarSnapshot } from "./state/snapshot.ts";
import { RenderScheduler, type SnapshotChange, SnapshotStore } from "./state/store.ts";
import { readTools } from "./state/tools.ts";
import { scanUsage, startScan, type UsageScan } from "./state/usage.ts";
import { countBranches, displayPath, shortSessionId, storageState } from "./state/workspace.ts";
import { formatAge } from "./ui/format.ts";
import { glyphsFor } from "./ui/glyphs.ts";
import { Palette } from "./ui/palette.ts";
import type { Action, ToggleKey } from "./ui/rows.ts";
import type { SidebarModel, SidebarView } from "./ui/sidebar.ts";
import { cleanText, errorText, isRecord, noColorRequested } from "./util.ts";
import { VERSION } from "./version.ts";

const PROBE_KEY = "pi-sidebar:host";
/** Tools that only read; anything else may have changed the working tree. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** The status clock and running tool times tick every second; the idle age every 30 seconds (LIFE-5). */
const BUSY_TICK_MS = 1_000;
const IDLE_TICK_MS = 30_000;
/** `user_bash` fires before the command runs; look a little later. */
const USER_BASH_GIT_DELAY_MS = 1_500;
/** Streaming speed estimates at most this often. */
const SPEED_SAMPLE_MS = 150;
const MAX_ERRORS = 20;

type Ui = ExtensionContext["ui"];

/** What to read besides context, totals and storage, which every refresh reads. */
interface Refresh {
  /** The estimated breakdown, from the active branch. */
  composition?: boolean;
  /** Branch count; walks the session tree. */
  history?: boolean;
  tools?: boolean;
}

export interface ControllerOptions {
  /** Where the settings live. */
  configFile: string;
  /** Pi's per-message token estimate (`estimateTokens` from the SDK): breakdown and streaming speed. */
  estimateTokens: EstimateMessage;
}

/**
 * The sidebar for one Pi runtime: settings, the snapshot the panels draw, the git monitor, the clock,
 * and the layout host that puts the sidebar on screen. Pi events feed it through `index.ts`.
 */
export class SidebarController implements SidebarModel, SidebarActions {
  config: SidebarConfig = defaultConfig();
  configWarnings: string[] = [];
  readonly errors: string[] = [];

  private readonly pi: ExtensionAPI;
  private readonly configFile: string;
  private readonly estimate: EstimateMessage;
  private readonly renders: RenderScheduler;
  private readonly store: SnapshotStore;
  private readonly layout: LayoutHost;
  private ui?: Ui;
  private theme?: Theme;
  private git?: GitMonitor;
  private cwd = "";
  /** A TUI session is running; handlers do nothing outside one. */
  private active = false;
  private flags: AgentFlags = idleFlags(Date.now());
  private usage: UsageScan = startScan();
  /** Context tokens when the current or last run started; the base of "+N this run". */
  private deltaBase?: number;
  /** System prompt and tool declarations as the latest model request carried them. */
  private requestParts?: { system?: number; tools?: number };
  private requestStartedAt?: number;
  private firstTokenAt?: number;
  private responseTtft?: number;
  private lastSpeedSample = 0;
  /** Lists opened with a click; they stay open for the session. */
  private opened: Record<Exclude<ToggleKey, "breakdown">, boolean> = { gitFiles: false, recentTools: false, toolNames: false };
  private width: 0 | SidebarWidth = 0;
  private activityQueued = false;
  private ticker?: ReturnType<typeof setInterval>;
  private tickMs = 0;
  private paletteCache?: { key: string; palette: Palette };
  private paletteEpoch = 0;
  private renderEpoch = 0;

  constructor(pi: ExtensionAPI, options: ControllerOptions) {
    this.pi = pi;
    this.configFile = options.configFile;
    this.estimate = options.estimateTokens;
    this.renders = new RenderScheduler(
      () => this.layout.requestRender(),
      () => this.flags.running,
      () => this.config.renderThrottleMs,
    );
    this.store = new SnapshotStore(emptySnapshot(Date.now()), () => this.renders.schedule());
    this.layout = new LayoutHost(this, {
      settings: () => this.layoutSettings(),
      widthChanged: (width) => this.onWidthChanged(width),
      failed: (reason) => this.notify(`pi-sidebar stopped: ${reason}. The main window is unchanged; see /sidebar status.`),
      reportError: (where, error) => this.reportError(where, error),
    });
  }

  // ---- lifecycle ----

  /** session_start (LIFE-2). */
  start(ctx: ExtensionContext): void {
    this.stop();
    if (ctx.mode !== "tui") return;
    try {
      const loaded = loadConfig(this.configFile);
      this.config = loaded.config;
      this.configWarnings = loaded.warnings;
      this.ui = ctx.ui;
      this.cwd = ctx.cwd;
      this.active = true;
      this.opened = { gitFiles: false, recentTools: false, toolNames: false };
      this.store.replace(this.initialSnapshot(ctx));
      this.git = new GitMonitor({
        exec: (args, timeout, signal) => this.pi.exec("git", args, { cwd: this.cwd, timeout, signal }),
        onState: (state) => this.onGitState(state),
        pollSeconds: this.config.git.pollSeconds,
      });
      ctx.ui.setWidget(
        PROBE_KEY,
        (tui, theme) => {
          this.theme = theme;
          return this.layout.attach(tuiPort(tui));
        },
        { placement: "belowEditor" },
      );
    } catch (error) {
      this.reportError("session_start", error);
    }
  }

  /** session_shutdown (LIFE-3): give Pi its layout back before the runtime goes away. */
  shutdown(ctx: ExtensionContext): void {
    this.stop();
    try {
      if (ctx.mode === "tui") ctx.ui.setWidget(PROBE_KEY, undefined);
    } catch (error) {
      this.reportError("session_shutdown", error);
    }
  }

  private stop(): void {
    this.active = false;
    this.layout.detach();
    this.git?.dispose();
    this.git = undefined;
    this.stopTicker();
    this.renders.cancel();
    this.ui = undefined;
    this.theme = undefined;
    this.paletteCache = undefined;
    this.width = 0;
    this.deltaBase = undefined;
    this.requestParts = undefined;
    this.requestStartedAt = undefined;
    this.firstTokenAt = undefined;
    this.responseTtft = undefined;
    this.lastSpeedSample = 0;
  }

  private initialSnapshot(ctx: ExtensionContext): SidebarSnapshot {
    const now = Date.now();
    const entries = this.attempt("read entries", () => ctx.sessionManager.getEntries()) ?? [];
    this.usage = scanUsage(entries, startScan());
    this.flags = idleFlags(lastActivity(entries) ?? now);
    const snapshot = { ...emptySnapshot(now), ...this.collect(ctx, { composition: true, history: true, tools: true }) };
    snapshot.session = {
      ...statusOf(this.flags),
      name: this.attempt("session name", () => sessionName(this.pi.getSessionName())),
      ...this.attempt("model", () => readModel(ctx.model, this.pi.getThinkingLevel())),
      billing: this.attempt("billing", () => readBilling(ctx)),
    };
    snapshot.git = this.config.panels.git ? { kind: "loading" } : { kind: "off" };
    return snapshot;
  }

  // ---- Pi events; each handler isolates its own errors (ERR-1) ----

  onAgentStart(ctx: ExtensionContext): void {
    this.handle("agent_start", () => {
      const now = Date.now();
      this.flags = { ...this.flags, running: true, outcome: undefined, runStartedAt: now, turn: undefined };
      this.deltaBase = this.store.snapshot.context?.tokens ?? undefined;
      this.git?.setBusy(true);
      const data = this.collect(ctx, { tools: true });
      this.store.update((s) => ({ ...data, session: { ...s.session, ...statusOf(this.flags) }, activity: startRun(s.activity, now) }), now);
      this.updateTicker();
    });
  }

  onTurnStart(turnIndex: number, ctx: ExtensionContext): void {
    this.handle("turn_start", () => {
      this.flags = { ...this.flags, turn: turnIndex + 1 };
      const queued = ctx.hasPendingMessages();
      this.store.update((s) => ({
        session: { ...s.session, ...statusOf(this.flags) },
        activity: { ...startTurn(s.activity, turnIndex), queued },
      }));
    });
  }

  onTurnEnd(ctx: ExtensionContext): void {
    this.handle("turn_end", () => {
      const data = this.collect(ctx, { composition: true, tools: true });
      const queued = ctx.hasPendingMessages();
      this.store.update((s) => ({ ...data, activity: { ...s.activity, queued } }));
    });
  }

  onBeforeSettle(outcome: RunOutcome): void {
    this.handle("agent_before_settle", () => {
      this.flags = { ...this.flags, outcome };
    });
  }

  onAgentSettled(aborted: boolean, ctx: ExtensionContext): void {
    this.handle("agent_settled", () => {
      const now = Date.now();
      const outcome: RunOutcome = aborted ? "aborted" : (this.flags.outcome ?? "completed");
      // A compaction that never reported its end does not outlive the run.
      this.flags = { ...this.flags, running: false, compacting: false, outcome, idleSince: now, turn: undefined };
      this.requestStartedAt = undefined;
      this.firstTokenAt = undefined;
      this.git?.setBusy(false);
      this.git?.request();
      const data = this.collect(ctx, { composition: true, history: true, tools: true });
      const queued = ctx.hasPendingMessages();
      this.store.update(
        (s) => ({ ...data, session: { ...s.session, ...statusOf(this.flags) }, activity: { ...endRun(s.activity, now, aborted), queued } }),
        now,
      );
      this.updateTicker();
    });
  }

  /** A model request is about to go out: the clock for time to first token starts. */
  onProviderRequest(): void {
    this.handle("before_provider_request", () => {
      this.requestStartedAt = Date.now();
      this.firstTokenAt = undefined;
      this.lastSpeedSample = 0;
    });
  }

  /**
   * Streaming updates arrive per token batch. The first one that carries output gives the TTFT;
   * later ones, sampled at most every 150 ms, give a running estimate of the speed. Most updates return after two
   * comparisons.
   */
  onMessageUpdate(message: unknown): void {
    if (!this.active || this.requestStartedAt === undefined || !isRecord(message) || message.role !== "assistant") return;
    const now = Date.now();
    if (this.firstTokenAt !== undefined && now - this.lastSpeedSample < SPEED_SAMPLE_MS) return;
    this.handle("message_update", () => {
      const tokens = messageTokens(message, this.estimate);
      if (tokens === 0) return;
      if (this.firstTokenAt === undefined) {
        this.firstTokenAt = now;
        this.responseTtft = now - (this.requestStartedAt ?? now);
        const ttftMs = this.responseTtft;
        this.store.update((s) => ({ activity: firstToken(s.activity, ttftMs) }), now);
        return;
      }
      this.lastSpeedSample = now;
      const speed = tokensPerSecond(tokens, now - this.firstTokenAt);
      if (speed !== undefined) this.store.update((s) => ({ activity: streamingSpeed(s.activity, speed) }), now);
    });
  }

  onMessageEnd(message: unknown, ctx: ExtensionContext): void {
    this.handle("message_end", () => {
      const now = Date.now();
      const role = isRecord(message) ? message.role : undefined;
      // A finished `!command` of the user.
      if (role === "bashExecution") this.git?.request();
      let done: { ttft?: number; speed?: number } | undefined;
      if (role === "assistant" && this.firstTokenAt !== undefined && isRecord(message) && isRecord(message.usage)) {
        const output = typeof message.usage.output === "number" ? message.usage.output : 0;
        done = { ttft: this.responseTtft, speed: tokensPerSecond(output, now - this.firstTokenAt) };
        this.requestStartedAt = undefined;
        this.firstTokenAt = undefined;
        this.responseTtft = undefined;
      }
      const data = this.collect(ctx);
      this.store.update(
        (s) => ({ ...data, activity: done === undefined ? s.activity : responseDone(s.activity, done.ttft, done.speed) }),
        now,
      );
    });
  }

  /** The transcript of a model request, after every context transform (`context_with_system`). Read only. */
  onRequestContext(messages: readonly unknown[]): void {
    this.handle("context_with_system", () => {
      const composition = compositionFromRequest(messages, this.estimate);
      this.requestParts = { system: composition.parts.system, tools: composition.parts.tools };
      this.store.update(() => ({ composition }));
    });
  }

  onInput(streaming: boolean): void {
    if (!streaming) return;
    this.handle("input", () => this.store.update((s) => ({ activity: { ...s.activity, queued: true } })));
  }

  onToolStart(event: ToolStart): void {
    this.handle("tool_execution_start", () => {
      const now = Date.now();
      this.store.update((s) => ({ activity: startTool(s.activity, event, now, this.cwd) }), now);
    });
  }

  onToolEnd(event: ToolEnd): void {
    this.handle("tool_execution_end", () => {
      const now = Date.now();
      this.store.update((s) => ({ activity: endTool(s.activity, event, now) }), now);
      if (!READ_ONLY_TOOLS.has(event.toolName)) this.git?.request();
    });
  }

  onModelSelect(model: ExtensionContext["model"], ctx: ExtensionContext): void {
    this.handle("model_select", () => {
      const info = readModel(model, this.pi.getThinkingLevel());
      const billing = this.attempt("billing", () => readBilling(ctx, model));
      const context = this.readContext(ctx, model);
      this.store.update((s) => ({ session: { ...s.session, ...info, billing }, context }));
    });
  }

  onThinkingSelect(level: string, ctx: ExtensionContext): void {
    this.handle("thinking_level_select", () => {
      const { thinking } = readModel(ctx.model, level);
      this.store.update((s) => ({ session: { ...s.session, thinking } }));
    });
  }

  onSessionInfo(name: string | undefined): void {
    this.handle("session_info_changed", () => {
      this.store.update((s) => ({ session: { ...s.session, name: sessionName(name) } }));
    });
  }

  /** session_tree: another branch; its context and growth start over. */
  onSessionTree(ctx: ExtensionContext): void {
    this.handle("session_tree", () => {
      this.deltaBase = undefined;
      const data = this.collect(ctx, { composition: true, history: true });
      this.store.update(() => data);
    });
  }

  onCompactStart(): void {
    this.handle("session_before_compact", () => {
      const now = Date.now();
      this.flags = { ...this.flags, compacting: true, compactStartedAt: now };
      this.store.update((s) => ({ session: { ...s.session, ...statusOf(this.flags) } }), now);
      this.updateTicker();
    });
  }

  /** session_compact and session_compact_failed. */
  onCompactEnd(ctx: ExtensionContext): void {
    this.handle("session_compact", () => {
      this.flags = { ...this.flags, compacting: false };
      this.deltaBase = undefined;
      const data = this.collect(ctx, { composition: true, history: true });
      this.store.update((s) => ({ ...data, session: { ...s.session, ...statusOf(this.flags) } }));
      this.updateTicker();
    });
  }

  onUserBash(): void {
    this.handle("user_bash", () => this.git?.request(USER_BASH_GIT_DELAY_MS));
  }

  /** MCP servers came or went, and their tools with them. */
  onToolsChanged(): void {
    this.handle("mcp_servers_change", () => {
      const tools = this.readTools();
      if (tools) this.store.update(() => ({ tools }));
    });
  }

  /**
   * Context, totals and storage on every refresh; breakdown, history and tools when asked. Each part is
   * read on its own, so one failure leaves the rest (ERR-1).
   */
  private collect(ctx: ExtensionContext, refresh: Refresh = {}): SnapshotChange {
    const change: SnapshotChange = {};
    const entries = this.attempt("read entries", () => ctx.sessionManager.getEntries());
    if (entries) {
      const usage = this.attempt("usage", () => scanUsage(entries, this.usage));
      if (usage) {
        this.usage = usage;
        change.usage = usage.totals;
      }
    }
    const context = this.attempt("context", () => ({ value: this.readContext(ctx) }));
    if (context) change.context = context.value;
    const workspace = this.attempt("workspace", () => this.readWorkspace(ctx, entries ?? [], refresh.history === true));
    if (workspace) change.workspace = workspace;
    if (refresh.composition) {
      const composition = this.attempt("breakdown", () => this.sessionComposition(ctx));
      if (composition) change.composition = composition;
    }
    if (refresh.tools) {
      const tools = this.readTools();
      if (tools) change.tools = tools;
    }
    return change;
  }

  private readContext(ctx: ExtensionContext, model = ctx.model): SidebarSnapshot["context"] {
    const context = readContext(ctx, this.pi.getSettings(), model);
    if (context && context.tokens !== null && this.deltaBase !== undefined) context.delta = context.tokens - this.deltaBase;
    return context;
  }

  private readWorkspace(ctx: ExtensionContext, entries: readonly unknown[], history: boolean): SidebarSnapshot["workspace"] {
    const manager = ctx.sessionManager;
    const previous = this.store.snapshot.workspace;
    return {
      cwd: cleanText(displayPath(ctx.cwd), 400),
      sessionId: shortSessionId(manager.getSessionId()),
      storage: storageState(manager.getSessionFile(), entries),
      entries: entries.length,
      branches: history ? countBranches(manager.getTree()) : previous.branches,
    };
  }

  /** The active branch between requests, with the prompt and tools of the latest request when known. */
  private sessionComposition(ctx: ExtensionContext): SidebarSnapshot["composition"] {
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    const system = this.requestParts?.system ?? estimateText(ctx.getSystemPrompt());
    const tools = this.requestParts?.tools ?? this.activeToolTokens();
    return compositionFromSession(messages, system, tools, this.estimate);
  }

  private activeToolTokens(): number | undefined {
    const active = new Set(this.pi.getActiveTools());
    return toolTokens(this.pi.getAllTools().filter((tool) => active.has(tool.name)));
  }

  private readTools(): SidebarSnapshot["tools"] {
    return this.attempt("tools", () => readTools(this.pi.getActiveTools(), this.pi.getAllTools()));
  }

  private onGitState(state: GitState): void {
    if (!this.active || !this.config.panels.git) return;
    this.store.update(() => ({ git: state }));
  }

  /** From the layout pass: only record, act after the frame. */
  private onWidthChanged(width: 0 | SidebarWidth): void {
    this.width = width;
    if (this.activityQueued) return;
    this.activityQueued = true;
    setTimeout(() => {
      this.activityQueued = false;
      this.syncActivity();
    }, 0);
  }

  /** Git refreshes and the clock run only while the sidebar is on screen (PERF-4, LIFE-5). */
  private syncActivity(): void {
    if (!this.active) return;
    // A folded GIT panel still shows the branch and the count in its title line.
    this.git?.setActive(this.width > 0 && this.config.panels.git);
    this.updateTicker();
  }

  private updateTicker(): void {
    const busy = this.flags.running || this.flags.compacting;
    const wanted = !this.active || this.width === 0 ? 0 : busy ? BUSY_TICK_MS : IDLE_TICK_MS;
    if (wanted === this.tickMs) return;
    this.stopTicker();
    this.tickMs = wanted;
    if (wanted === 0) return;
    this.ticker = setInterval(() => this.store.update(() => ({})), wanted);
    this.ticker.unref();
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
    this.tickMs = 0;
  }

  // ---- SidebarModel ----

  get snapshot(): SidebarSnapshot {
    return this.store.snapshot;
  }

  view(): SidebarView {
    const { config } = this;
    return {
      g: glyphsFor(config.icons, this.colorMode()),
      warnPercent: config.contextWarnPercent,
      dangerPercent: config.contextDangerPercent,
      recentTools: config.recentTools,
      maxFiles: config.git.maxFiles,
      expanded: { ...this.opened, breakdown: config.contextBreakdown },
      panels: config.panels,
      folded: new Set(config.folded),
    };
  }

  palette(): Palette {
    const theme = this.theme;
    if (!theme) throw new Error("no theme yet");
    const key = this.paletteKey();
    if (this.paletteCache?.key !== key) this.paletteCache = { key, palette: new Palette(theme, this.colorMode()) };
    return this.paletteCache.palette;
  }

  rows(): number {
    return this.layout.rows();
  }

  renderKey(): string {
    return `${this.store.snapshot.version}|${this.renderEpoch}|${this.paletteKey()}`;
  }

  /** Pi invalidates components when the theme changes; the palette is rebuilt. */
  invalidate(): void {
    this.paletteEpoch++;
  }

  reportError(where: string, error: unknown): void {
    this.errors.push(`${new Date().toTimeString().slice(0, 8)} ${where}: ${errorText(error)}`);
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
  }

  /** A click in the sidebar: fold a panel (saved), open or close a section. Runs outside rendering. */
  act(action: Action): void {
    try {
      if (action.type === "fold") {
        this.setFold(action.panel, !this.config.folded.includes(action.panel));
      } else if (action.key === "breakdown") {
        this.setBreakdown(!this.config.contextBreakdown);
      } else {
        this.opened = { ...this.opened, [action.key]: !this.opened[action.key] };
        this.renderEpoch++;
        this.layout.requestRender();
      }
    } catch (error) {
      this.reportError("click", error);
    }
  }

  colorMode(): ColorMode {
    return noColorRequested() ? "mono" : this.config.colors;
  }

  // ---- /sidebar (UX-2: every setting applies at once and is saved) ----

  setEnabled(enabled: boolean): string {
    this.config = { ...this.config, enabled };
    if (enabled) this.layout.retry();
    return this.withModeNote(`sidebar: ${enabled ? "on" : "off"} ${this.apply()}`);
  }

  setWidth(width: WidthSetting): string {
    this.config = { ...this.config, width };
    const detail =
      width === "auto" ? `auto · 36 when main keeps >= ${this.config.minMainWidth} cols, else 28, else hidden` : String(width);
    return this.withModeNote(`sidebar: width set to ${detail} ${this.apply()}`);
  }

  setMinMainWidth(columns: number): string {
    this.config = { ...this.config, minMainWidth: columns };
    return this.withModeNote(`sidebar: min-main set to ${columns} ${this.apply()}`);
  }

  setPanel(panel: BodyPanel, on: boolean): string {
    this.config = { ...this.config, panels: { ...this.config.panels, [panel]: on } };
    const note = panel === "git" && !on ? " · no git processes will be started" : "";
    return `sidebar: panel ${panel} ${on ? "on" : "off"} ${this.apply()}${note}`;
  }

  setFold(panel: PanelName | "all", folded: boolean): string {
    const names = panel === "all" ? PANEL_NAMES : [panel];
    const rest = this.config.folded.filter((name) => !names.includes(name));
    this.config = { ...this.config, folded: folded ? [...rest, ...names] : rest };
    return `sidebar: ${panel === "all" ? "all panels" : `panel ${panel}`} ${folded ? "folded" : "unfolded"} ${this.apply()}`;
  }

  setBreakdown(on: boolean): string {
    this.config = { ...this.config, contextBreakdown: on };
    return `sidebar: context breakdown ${on ? "shown" : "hidden"} ${this.apply()}`;
  }

  setGitFiles(count: number): string {
    this.config = { ...this.config, git: { ...this.config.git, maxFiles: count } };
    return `sidebar: git files set to ${count} (listed at width 36) ${this.apply()}`;
  }

  setColors(colors: ColorMode): string {
    this.config = { ...this.config, colors };
    const note = noColorRequested() && colors !== "mono" ? " · NO_COLOR is set, so mono stays in effect" : "";
    return `sidebar: colors set to ${colors} ${this.apply()}${note}`;
  }

  setIcons(icons: IconMode): string {
    this.config = { ...this.config, icons };
    return `sidebar: icons set to ${icons} ${this.apply()}`;
  }

  reset(): string {
    const changed = changedSettings(this.config);
    this.config = defaultConfig();
    this.layout.retry();
    const saved = this.apply();
    if (changed.length === 0) return `sidebar: settings already at defaults ${saved}`;
    return `sidebar: reset ${changed.length} setting${changed.length > 1 ? "s" : ""} to defaults: ${changed.join(", ")} ${saved}`;
  }

  /** `/sidebar status` (UX-6). */
  statusText(): string {
    const layout = this.layout.info();
    const { config } = this;
    const min = config.minMainWidth;
    let headline = `pi-sidebar ${VERSION} · ${layout.mode} · ${layout.state}`;
    if (layout.state === "mounted") headline += layout.width > 0 ? " · visible" : ` · hidden (${this.hiddenReason(layout.columns)})`;
    else if (layout.state === "failed") headline += ` (${layout.failure ?? "unknown"}; sidebar off, main window untouched)`;
    else if (layout.state === "inactive") headline += " (sidebar needs fullscreen mode)";
    else if (layout.state === "disabled") headline += " (/sidebar off)";
    const rules =
      config.width === "auto"
        ? `auto · 36 if cols-36 >= ${min}, else 28 if cols-28 >= ${min}, else hidden`
        : `fixed · ${config.width} if cols-${config.width} >= ${min}, else hidden`;
    const shown = ["session", "context", ...BODY_PANELS.filter((panel) => config.panels[panel])];
    const hidden = BODY_PANELS.filter((panel) => !config.panels[panel]);
    const host = !layout.wrapped
      ? "layout root not wrapped"
      : layout.nested
        ? "wrapped, nested inside another extension's layout root"
        : "layout root wrapped (owner ok)";
    const { mounts, remounts, conflicts, probeFrames, widthChanges } = layout.stats;
    const composition = this.store.snapshot.composition;
    const breakdown = !config.contextBreakdown
      ? "hidden"
      : composition
        ? `estimated from the ${composition.source === "request" ? "latest request" : "active branch"}`
        : "not yet estimated";
    return [
      headline,
      `size     width ${layout.width > 0 ? layout.width : "0 (hidden)"} (${config.width}) · main ${layout.columns - layout.width} · terminal ${layout.columns}x${layout.rows}`,
      `rules    ${rules} · +${STEP_UP_MARGIN} cols to step up`,
      `look     colors ${this.colorMode()}${noColorRequested() ? " (NO_COLOR)" : ""} · icons ${config.icons} · theme ${this.theme?.name ?? "?"}`,
      `panels   ${shown.join(", ")}${hidden.length > 0 ? ` · off: ${hidden.join(", ")}` : ""}${config.folded.length > 0 ? ` · folded: ${config.folded.join(", ")}` : ""}`,
      `context  breakdown ${breakdown}`,
      `git      ${this.gitStatus()}`,
      `host     ${host} · mounts ${mounts} · remounts ${remounts} · conflicts ${conflicts} · probe frames ${probeFrames} · width changes ${widthChanges}`,
      `config   ${this.configFile}${this.configWarnings.length > 0 ? ` · ${this.configWarnings.join("; ")}` : ""}`,
      `errors   ${this.errors.length > 0 ? this.errors.slice(-3).join(" | ") : "none"}`,
    ].join("\n");
  }

  /** Debug aid: the last fullscreen frame as text, to check a layout without a screenshot. */
  dumpScreen(): string {
    const lines = this.layout.screenLines();
    if (!lines) return "sidebar: no fullscreen frame to dump (fullscreen TUI mode only)";
    const base = join(tmpdir(), "pi-sidebar-screen");
    writeFileSync(`${base}.ans`, `${lines.join("\n")}\n`, "utf8");
    writeFileSync(`${base}.txt`, `${lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n")}\n`, "utf8");
    return `sidebar: wrote ${lines.length} screen rows to ${base}.txt (colours in ${base}.ans)`;
  }

  /** Save, then apply the settings at once. */
  private apply(): string {
    const saved = this.persist();
    this.renderEpoch++;
    if (this.active) {
      this.git?.setPollSeconds(this.config.git.pollSeconds);
      if (!this.config.panels.git) {
        this.git?.setActive(false);
        if (this.store.snapshot.git.kind !== "off") this.store.update(() => ({ git: { kind: "off" } }));
      } else if (this.store.snapshot.git.kind === "off") {
        this.store.update(() => ({ git: { kind: "loading" } }));
        this.git?.request(0);
      }
      this.syncActivity();
    }
    this.layout.refresh();
    return saved;
  }

  private persist(): string {
    try {
      saveConfig(this.config, this.configFile);
      return "(saved)";
    } catch (error) {
      this.reportError("save config", error);
      return `(not saved: ${errorText(error)})`;
    }
  }

  private gitStatus(): string {
    if (!this.config.panels.git) return "off (no git processes)";
    const poll = this.config.git.pollSeconds > 0 ? `polls every ${this.config.git.pollSeconds}s while visible and idle` : "no polling";
    const state = this.store.snapshot.git;
    switch (state.kind) {
      case "off":
        return "off";
      case "loading":
        return `waiting for the first refresh · ${poll}`;
      case "none":
        return "not a git repository";
      case "error":
        return `error: ${state.message} · ${poll}`;
      case "ok":
        return `ok · ${state.info.files.length} changed · refreshed ${formatAge(Date.now() - state.at)} ago (${state.tookMs} ms) · ${poll}`;
    }
  }

  private hiddenReason(columns: number): string {
    if (columns <= 0) return "waiting for the first frame";
    const narrowest = this.config.width === "auto" ? 28 : this.config.width;
    const main = columns - narrowest;
    const min = this.config.minMainWidth;
    if (main < min) return `main would be ${main} < ${min}${this.config.width === "auto" ? " even at width 28" : ""}`;
    return `main would be ${main} at width ${narrowest}; showing it again needs ${min + STEP_UP_MARGIN}`;
  }

  private withModeNote(text: string): string {
    const { mode } = this.layout.info();
    if (!this.config.enabled || mode === "fullscreen" || mode === "no tui") return text;
    return `${text} · fullscreen TUI mode is required to show it (current: ${mode}; switch in /settings -> TUI mode)`;
  }

  private layoutSettings(): LayoutSettings {
    const { enabled, width, minMainWidth, icons } = this.config;
    return { enabled, width, minMainWidth, icons };
  }

  private paletteKey(): string {
    return `${this.theme?.name ?? "?"}|${this.colorMode()}|${this.paletteEpoch}`;
  }

  private notify(text: string): void {
    try {
      this.ui?.notify(text, "warning");
    } catch {
      // Notifications are best effort.
    }
  }

  private handle(where: string, action: () => void): void {
    if (!this.active) return;
    try {
      action();
    } catch (error) {
      this.reportError(where, error);
    }
  }

  private attempt<T>(where: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      this.reportError(where, error);
      return undefined;
    }
  }
}
