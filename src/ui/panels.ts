import { visibleWidth } from "@earendil-works/pi-tui";
import type { PanelName } from "../config.ts";
import { average, MAX_RECENT_TOOLS } from "../state/activity.ts";
import { partCells } from "../state/composition.ts";
import {
  type AgentStatus,
  type Composition,
  type GitFile,
  type GitFileStatus,
  type GitInfo,
  PART_NAMES,
  type PartName,
  type SidebarSnapshot,
  type ToolCounts,
  type ToolRun,
} from "../state/snapshot.ts";
import { formatAge, formatClock, formatCost, formatDuration, formatPercent, formatTokens } from "./format.ts";
import type { Glyphs } from "./glyphs.ts";
import type { PanelRole, Role } from "./palette.ts";
import { type Row, row, type ToggleKey, toggleAction } from "./rows.ts";
import { bar, elideEnd, elideStart, type Line, lineWidth, lr, type Seg, seg } from "./text.ts";

/** compact = the 28-column sidebar, normal = the 36-column one (design §5.2). */
export type Tier = "compact" | "normal";

/** Settings and open sections the panels draw with. */
export interface PanelView {
  readonly g: Glyphs;
  readonly warnPercent: number;
  readonly dangerPercent: number;
  readonly recentTools: number;
  readonly maxFiles: number;
  readonly expanded: Readonly<Record<ToggleKey, boolean>>;
}

export interface Panel {
  readonly role: PanelRole;
  readonly title: string;
  /** Title of the folded line when it differs, e.g. USAGE without "· session". */
  readonly shortTitle?: string;
  /** Shown after the title while the panel is folded. */
  readonly summary: string;
  readonly rows: Row[];
}

export const PART_LABELS: Readonly<Record<PartName, string>> = {
  system: "System",
  tools: "Tools",
  messages: "Messages",
  toolResults: "Tool results",
  summary: "Summary",
  other: "Other",
};

/** Running tools shown at most; the rest of the list is finished ones. */
const MAX_RUNNING_SHOWN = 3;
const COMPACT_RECENT_TOOLS = 2;
/** Files listed once the list is opened with a click. */
const OPEN_GIT_FILES = 20;

/** Rows of one panel for content `width` columns wide. */
export function buildPanel(name: PanelName, snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  switch (name) {
    case "session":
      return sessionPanel(snapshot, view, tier, width);
    case "context":
      return contextPanel(snapshot, view, tier, width);
    case "usage":
      return usagePanel(snapshot, view, tier, width);
    case "activity":
      return activityPanel(snapshot, view, tier, width);
    case "git":
      return gitPanel(snapshot, view, tier, width);
    case "tools":
      return toolsPanel(snapshot, view, tier, width);
    case "workspace":
      return workspacePanel(snapshot, view, tier, width);
  }
}

// ---- SESSION ----

const STATUS: Readonly<Record<AgentStatus, { label: string; role: Role }>> = {
  ready: { label: "READY", role: "ok" },
  working: { label: "WORKING", role: "run" },
  compacting: { label: "COMPACTING", role: "warn" },
  error: { label: "ERROR", role: "err" },
};

function sessionPanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { session } = snapshot;
  const { g } = view;
  const rows: Row[] = [
    row(session.name ? [seg(session.name, "value", true)] : [seg("(unnamed)", "faint")]),
    row(statusLine(snapshot, view, width)),
    row(modelLine(snapshot, view, width)),
  ];
  if (tier === "normal" && (session.provider || session.billing)) {
    rows.push(row(lr([seg(session.provider ?? "", "label")], session.billing ? [seg(session.billing, "faint")] : [], width, g.ellipsis)));
  }
  const summary = [STATUS[session.status].label, session.model].filter(Boolean).join(` ${g.dot} `);
  return { role: "session", title: "SESSION", summary, rows };
}

function statusMark(status: AgentStatus, clock: number, g: Glyphs): string {
  switch (status) {
    case "ready":
      return g.ready;
    case "working":
      return g.working[Math.floor(clock / 1000) % g.working.length] ?? g.ready;
    case "compacting":
      return g.compacting;
    case "error":
      return g.error;
  }
}

/** "● READY  idle 2m", or "◐ WORKING · turn 3  0:42" with the spinner turning once a second. */
export function statusLine(snapshot: SidebarSnapshot, view: PanelView, width: number): Line {
  const { session } = snapshot;
  const { g } = view;
  const { label, role } = STATUS[session.status];
  const left: Seg[] = [seg(`${statusMark(session.status, snapshot.clock, g)} `, role), seg(label, role, true)];
  if (session.status === "working" && session.turn !== undefined) left.push(seg(` ${g.dot} turn ${session.turn}`, "faint"));
  const elapsed = Math.max(0, snapshot.clock - session.since);
  const busy = session.status === "working" || session.status === "compacting";
  const right = busy ? [seg(formatClock(elapsed), role)] : [seg(`idle ${formatAge(elapsed)}`, "faint")];
  return lr(left, right, width, g.ellipsis);
}

export function modelLine(snapshot: SidebarSnapshot, view: PanelView, width: number): Line {
  const { session } = snapshot;
  const left = session.model ? [seg(session.model, "value")] : [seg("no model", "faint")];
  const right = session.thinking ? [seg(session.thinking, `think:${session.thinking}`)] : [];
  return lr(left, right, width, view.g.ellipsis);
}

// ---- CONTEXT ----

interface ContextLevel {
  fill: Role;
  value: Role;
  percent: Role;
  danger: boolean;
}

function contextLevel(percent: number | null, view: PanelView): ContextLevel {
  if (percent === null) return { fill: "track", value: "label", percent: "faint", danger: false };
  if (percent >= view.dangerPercent) return { fill: "err", value: "err", percent: "err", danger: true };
  if (percent >= view.warnPercent) return { fill: "warn", value: "warn", percent: "warn", danger: false };
  return { fill: "ok", value: "value", percent: "context", danger: false };
}

/**
 * The bar shows the auto-compact threshold only while compaction is on (D-2), and this run's
 * growth as an accent-coloured end of the used part.
 */
export function contextBarLine(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Line {
  const { context } = snapshot;
  const { g } = view;
  if (!context) return [seg("context window unknown", "faint")];
  const level = contextLevel(context.percent, view);
  const threshold = context.compactAt === undefined ? undefined : (context.compactAt / context.window) * 100;
  const cells = width - (tier === "compact" ? 7 : 8);
  const delta = context.delta ?? 0;
  const accent = delta > 0 && context.window > 0 ? Math.max(1, Math.round((cells * delta) / context.window)) : 0;
  const percent = context.percent === null ? "?" : formatPercent(context.percent);
  return lr(bar(context.percent, threshold, cells, level.fill, g.bar, accent), [seg(percent, level.percent, true)], width, g.ellipsis);
}

function signedTokens(value: number, g: Glyphs): string {
  return `${value < 0 ? g.minus : "+"}${formatTokens(Math.abs(value))}`;
}

function contextPanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { context } = snapshot;
  const { g } = view;
  const rows: Row[] = [row(contextBarLine(snapshot, view, tier, width))];
  if (context) {
    const level = contextLevel(context.percent, view);
    const used: Seg[] = [
      seg(context.tokens === null ? "?" : formatTokens(context.tokens), level.value),
      seg(` / ${formatTokens(context.window)}`, "label"),
    ];
    let right: Seg[] = [];
    if (context.tokens === null) {
      if (tier === "normal") right = [seg("after next reply", "faint")];
    } else if (context.delta !== undefined && context.delta !== 0) {
      right = [seg(signedTokens(context.delta, g), context.delta > 0 ? "run" : "warn")];
      if (tier === "normal") right.push(seg(" this run", "faint"));
    }
    rows.push(row(lr(used, right, width, g.ellipsis)));
    if (tier === "normal" && context.compactAt !== undefined) {
      rows.push(row(lr([seg("Auto-compact at", "label")], [seg(formatTokens(context.compactAt), "faint")], width, g.ellipsis)));
      if (level.danger) rows.push(row([seg("! near auto-compact threshold", "err")]));
    }
  } else if (tier === "normal") {
    rows.push(row([seg("(model has no contextWindow)", "faint")]));
  }
  rows.push(...breakdownRows(snapshot.composition, view, tier, width));
  const summary =
    context?.percent != null ? `${formatPercent(context.percent)} ${g.dot} ${formatTokens(context.tokens ?? 0)}` : context ? "?" : "";
  return { role: "context", title: "CONTEXT", summary, rows };
}

/** The estimated parts of the context (D-11): a click on the first row opens or closes the list. */
function breakdownRows(composition: Composition | undefined, view: PanelView, tier: Tier, width: number): Row[] {
  const { g } = view;
  const open = view.expanded.breakdown;
  const total = composition ? `~${formatTokens(composition.total)}${tier === "normal" ? " est" : ""}` : g.none;
  const header = row(
    lr([seg(`${open ? g.unfolded : g.folded} `, "context"), seg("Breakdown", "label")], [seg(total, "faint")], width, g.ellipsis),
    toggleAction("breakdown"),
  );
  if (!open || !composition) return [header];
  const rows: Row[] = [header, row(partsBar(composition, width, g))];
  for (const part of PART_NAMES) {
    const tokens = composition.parts[part];
    if (tokens === 0) continue;
    const share = tokens === undefined || composition.total === 0 ? undefined : (tokens / composition.total) * 100;
    const percent = share === undefined ? "" : tier === "normal" ? `${share.toFixed(1)}%`.padStart(7) : `${Math.round(share)}%`.padStart(5);
    rows.push(
      row(
        lr(
          [seg(`${g.partMarks[part]} `, `part:${part}`), seg(PART_LABELS[part], "label")],
          [seg(tokens === undefined ? "?" : `~${formatTokens(tokens)}`, "value"), seg(percent, "faint")],
          width,
          g.ellipsis,
        ),
      ),
    );
  }
  if (composition.images > 0) {
    rows.push(row(lr([seg("  Images", "label")], [seg(String(composition.images), "value")], width, g.ellipsis)));
  }
  return rows;
}

/** One bar across the panel, each part in its own colour (or glyph without colour). */
function partsBar(composition: Composition, width: number, g: Glyphs): Line {
  const cells = partCells(composition.parts, width);
  const segs: Seg[] = [];
  for (const part of PART_NAMES) if (cells[part] > 0) segs.push(seg(g.parts[part].repeat(cells[part]), `part:${part}`));
  return segs.length > 0 ? segs : [seg(g.bar.track.repeat(width), "track")];
}

// ---- USAGE ----

function usagePanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { usage, session } = snapshot;
  const { g } = view;
  // Like the footer, a hit rate only once the session has used the cache.
  const cached = usage.cacheRead > 0 || usage.cacheWrite > 0;
  const hit = cached && usage.hitRate !== undefined ? `${Math.round(usage.hitRate)}%` : g.none;
  const summary = `${formatCost(usage.cost)} ${g.dot} ${formatTokens(usage.input + usage.output)}`;
  if (tier === "compact") {
    return {
      role: "usage",
      title: "USAGE",
      summary,
      rows: [
        row(lr([seg("in ", "label"), seg(formatTokens(usage.input), "input")], [seg("out ", "label"), seg(formatTokens(usage.output), "output")], width, g.ellipsis)),
        row(lr([seg("hit ", "label"), seg(hit, "cache")], [seg(formatCost(usage.cost), "cost", true)], width, g.ellipsis)),
      ],
    };
  }
  const cost: Seg[] = [seg(formatCost(usage.cost), "cost", true)];
  if (session.billing) cost.push(seg(` ${g.dot} ${session.billing}`, "faint"));
  return {
    role: "usage",
    title: `USAGE ${g.dot} session`,
    shortTitle: "USAGE",
    summary,
    rows: [
      row(lr([seg("Input", "label")], [seg(formatTokens(usage.input), "input")], width, g.ellipsis)),
      row(lr([seg("Output", "label")], [seg(formatTokens(usage.output), "output")], width, g.ellipsis)),
      row(lr([seg("Cache read", "label")], [seg(formatTokens(usage.cacheRead), "cache"), seg(` ${g.dot} hit `, "label"), seg(hit, "cache")], width, g.ellipsis)),
      row(lr([seg("Cost", "label")], cost, width, g.ellipsis)),
    ],
  };
}

// ---- ACTIVITY ----

function activityPanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { activity, session } = snapshot;
  const { g } = view;
  const working = session.status === "working";
  const rows: Row[] = [];
  const { run } = activity;
  if (!working && run?.endedAt !== undefined) {
    const label = tier === "compact" ? "Last run " : `Last run ${g.dot} `;
    const turns = run.turns > 0 ? [seg(`${run.turns} turn${run.turns === 1 ? "" : "s"}`, "faint")] : [];
    rows.push(row(lr([seg(label, "label"), seg(formatDuration(run.endedAt - run.startedAt), "activity")], turns, width, g.ellipsis)));
  }
  const running = activity.running.slice(0, MAX_RUNNING_SHOWN);
  for (const tool of running) rows.push(row(toolLine(tool, snapshot.clock - tool.startedAt, view, tier, width)));
  const open = view.expanded.recentTools;
  const usual = Math.max(0, (tier === "compact" ? Math.min(COMPACT_RECENT_TOOLS, view.recentTools) : view.recentTools) - running.length);
  const recent = activity.recent.slice(0, open ? Math.max(usual, MAX_RECENT_TOOLS - running.length) : usual);
  for (const tool of recent) rows.push(row(toolLine(tool, tool.durationMs ?? 0, view, tier, width)));
  const toggle = toggleAction("recentTools");
  if (!open && activity.recent.length > recent.length) {
    rows.push(row([seg(`${g.ellipsis} ${activity.recent.length - recent.length} more`, "faint")], toggle));
  } else if (open && activity.recent.length > usual) {
    rows.push(row([seg(`${g.fewer} fewer`, "faint")], toggle));
  }
  const counts = countsRow(activity.counts, view, width);
  if (counts) rows.push(counts);
  rows.push(...performanceRows(activity, view, width));
  if (activity.queued) rows.push(row([seg(`${g.queued} `, "warn"), seg("queued message", "warn")]));
  if (rows.length === 0) rows.push(row([seg(working ? "no tools yet" : "no activity yet", "faint")]));
  const summary = working
    ? `turn ${session.turn ?? 1}`
    : run?.endedAt !== undefined
      ? `last ${formatDuration(run.endedAt - run.startedAt)}`
      : "idle";
  return { role: "activity", title: "ACTIVITY", summary, rows };
}

/**
 * "Tools  9 ok · 1 failed": the tools of the current or last run by outcome; with the marks of the tool lines ("✓ 9  ✗ 1  ○ 2") where the words do not fit.
 */
function countsRow(counts: ToolCounts, view: PanelView, width: number): Row | undefined {
  if (counts.ok + counts.failed + counts.cancelled === 0) return undefined;
  const { g } = view;
  const entries: [number, string, string, Role][] = [
    [counts.ok, "ok", g.ok, "ok"],
    [counts.failed, "failed", g.fail, "err"],
    [counts.cancelled, "cancelled", g.cancelled, "faint"],
  ];
  const present = entries.filter(([count]) => count > 0);
  const words: Seg[] = [];
  for (const [count, word, , role] of present) {
    if (words.length > 0) words.push(seg(` ${g.dot} `, "faint"));
    words.push(seg(`${count} ${word}`, role));
  }
  const label = [seg("Tools", "label")];
  if (lineWidth(label) + 1 + lineWidth(words) <= width) return row(lr(label, words, width, g.ellipsis));
  const marks: Seg[] = [];
  for (const [count, , mark, role] of present) {
    if (marks.length > 0) marks.push(seg("  "));
    marks.push(seg(`${mark} ${count}`, role));
  }
  return row(lr(label, marks, width, g.ellipsis));
}

const ttftRole = (ms: number): Role => (ms < 2_000 ? "ok" : ms < 5_000 ? "value" : "warn");
const speedRole = (tokens: number): Role => (tokens >= 50 ? "ok" : tokens >= 20 ? "value" : "warn");

/** The latest response's TTFT and speed ("~" while streaming), and the run's averages once there are two. */
function performanceRows(activity: SidebarSnapshot["activity"], view: PanelView, width: number): Row[] {
  const { g } = view;
  const rows: Row[] = [];
  const line = (label: string, ttftMs: number | undefined, speed: number | undefined, estimated: boolean) => {
    const left = ttftMs === undefined ? [] : [seg(label, "label"), seg(formatDuration(ttftMs), ttftRole(ttftMs))];
    const right = speed === undefined ? [] : [seg(`${estimated ? "~" : ""}${Math.round(speed)} tok/s`, speedRole(speed))];
    if (left.length > 0 || right.length > 0) rows.push(row(lr(left.length > 0 ? left : [seg(label.trim(), "label")], right, width, g.ellipsis)));
  };
  line("TTFT ", activity.ttftMs, activity.tokensPerSecond, activity.speedEstimated === true);
  if (activity.samples.ttft.length > 1 || activity.samples.tps.length > 1) {
    line("Avg ", average(activity.samples.ttft), average(activity.samples.tps), false);
  }
  return rows;
}

const OUTCOME_ROLES: Readonly<Record<ToolRun["outcome"], Role>> = { running: "run", ok: "ok", error: "err", cancelled: "faint" };

function toolLine(tool: ToolRun, durationMs: number, view: PanelView, tier: Tier, width: number): Line {
  const { g } = view;
  const marks: Readonly<Record<ToolRun["outcome"], string>> = { running: g.run, ok: g.ok, error: g.fail, cancelled: g.cancelled };
  const mark = marks[tool.outcome];
  const role = OUTCOME_ROLES[tool.outcome];
  const duration = formatDuration(durationMs);
  const name = `${tool.name.padEnd(5)} `;
  const left: Seg[] = [seg(`${mark} `, role), seg(name, "value")];
  if (tier === "normal" && tool.summary !== "") {
    const room = width - visibleWidth(`${mark} `) - visibleWidth(name) - visibleWidth(duration) - 1;
    const summary = tool.summaryIsPath ? elideStart(tool.summary, room, g.ellipsis) : elideEnd(tool.summary, room, g.ellipsis);
    if (room > 0) left.push(seg(summary, "faint"));
  }
  return lr(left, [seg(duration, tool.outcome === "ok" ? "faint" : role)], width, g.ellipsis);
}

// ---- GIT ----

function gitPanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { git } = snapshot;
  const { g } = view;
  const note = (text: string, summary: string, role: Role = "faint"): Panel => ({
    role: "git",
    title: "GIT",
    summary,
    rows: [row([seg(text, role)])],
  });
  switch (git.kind) {
    case "off":
      return note("git panel off", "off");
    case "loading":
      return note(`loading${g.ellipsis}`, "");
    case "none":
      return note("not a git repository", "no repository");
    case "error":
      return note(`git: ${git.message}`, git.message, git.message.startsWith("slow") ? "warn" : "err");
    case "ok": {
      const { info } = git;
      const count = info.files.length;
      const summary = `${info.branch ?? info.commit ?? "?"} ${g.dot} ${count === 0 ? "clean" : `${count} changed`}`;
      return { role: "git", title: "GIT", summary, rows: gitRows(info, view, tier, width) };
    }
  }
}

function gitRows(info: GitInfo, view: PanelView, tier: Tier, width: number): Row[] {
  const { g } = view;
  const name = info.branch ?? `(detached ${info.commit ?? "?"})`;
  const sync: Seg[] = [];
  if (info.ahead > 0) sync.push(seg(`${g.ahead}${info.ahead}`, "ok"));
  if (info.behind > 0) sync.push(seg(`${sync.length > 0 ? " " : ""}${g.behind}${info.behind}`, "faint"));
  if (tier === "normal" && info.branch !== undefined) {
    sync.push(seg(`${sync.length > 0 ? " " : ""}${info.upstream ?? "no upstream"}`, "faint"));
  }
  const rows: Row[] = [row(lr([seg(`${g.branch} `, "git"), seg(name, "git", true)], sync, width, g.ellipsis))];
  const count = info.files.length;
  if (count === 0) {
    rows.push(row([seg("clean", "faint")]));
    return rows;
  }
  const diff: Seg[] = [seg(`+${info.added}`, "add"), seg(" "), seg(`${g.minus}${info.removed}`, "del")];
  const open = view.expanded.gitFiles;
  const toggle = toggleAction("gitFiles");
  // At 28 columns the list stays closed until the count is clicked.
  const usual = tier === "compact" ? 0 : view.maxFiles;
  const limit = open ? Math.max(usual, OPEN_GIT_FILES) : usual;
  if (tier === "compact") {
    rows.push(row(lr([seg(`${count} changed `, "value"), seg(open ? g.unfolded : g.folded, "faint")], diff, width, g.ellipsis), toggle));
  } else {
    rows.push(row(lr([seg("Changed ", "label"), seg(`${count} ${count === 1 ? "file" : "files"}`, "value")], diff, width, g.ellipsis), toggle));
    if (count > Math.min(count, limit)) rows.push(row(statusCounts(info, view)));
  }
  for (const file of info.files.slice(0, limit)) rows.push(row(fileLine(file, view, width)));
  const hidden = count - Math.min(count, limit);
  if (open) {
    if (hidden > 0) rows.push(row([seg(`${g.ellipsis} ${hidden} more`, "faint")]));
    rows.push(row([seg(`${g.fewer} fewer`, "faint")], toggle));
  } else if (tier === "normal" && hidden > 0) {
    rows.push(row([seg(`${g.ellipsis} ${hidden} more`, "faint")], toggle));
  }
  return rows;
}

const FILE_ROLES: Readonly<Record<GitFileStatus, Role>> = { M: "mod", A: "ok", D: "err", R: "run", "?": "untracked", U: "err" };
const COUNT_ORDER: readonly GitFileStatus[] = ["U", "M", "A", "D", "R", "?"];

/** "M 2  A 1  ? 4": files per status, shown when the list does not show them all. */
function statusCounts(info: GitInfo, view: PanelView): Line {
  const counts = new Map<GitFileStatus, number>();
  for (const file of info.files) counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
  const segs: Seg[] = [];
  for (const status of COUNT_ORDER) {
    const count = counts.get(status);
    if (!count) continue;
    if (segs.length > 0) segs.push(seg(` ${view.g.dot} `, "faint"));
    segs.push(seg(`${status} ${count}`, FILE_ROLES[status]));
  }
  return segs;
}

function fileLine(file: GitFile, view: PanelView, width: number): Line {
  const { g } = view;
  let right: Seg[] = [];
  if (file.status === "?") right = [seg("new", "faint")];
  else if (file.binary) right = [seg("bin", "faint")];
  else if (file.added !== undefined) right = [seg(`+${file.added}`, "add"), seg(" "), seg(`${g.minus}${file.removed ?? 0}`, "del")];
  const room = width - 2 - lineWidth(right) - (right.length > 0 ? 1 : 0);
  return lr([seg(`${file.status} `, FILE_ROLES[file.status]), seg(elideStart(file.path, room, g.ellipsis), "value")], right, width, g.ellipsis);
}

// ---- TOOLS ----

function toolsPanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { tools } = snapshot;
  const { g } = view;
  if (!tools) return { role: "tools", title: "TOOLS", summary: "", rows: [row([seg("no tool information yet", "faint")])] };
  const open = view.expanded.toolNames;
  const rows: Row[] = [
    row(
      lr(
        [seg(tier === "compact" ? "" : "Active ", "label"), seg(String(tools.active.length), "value"), seg(` / ${tools.total}`, "label")],
        [seg(`${open ? g.unfolded : g.folded} names`, "faint")],
        width,
        g.ellipsis,
      ),
      toggleAction("toolNames"),
    ),
  ];
  const groups = [
    ["builtin", tools.builtin],
    ["mcp", tools.mcp],
    ["ext", tools.extension],
  ] as const;
  const shown = groups.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  if (shown.length > 0) rows.push(row([seg(shown.join(` ${g.dot} `), "faint")]));
  if (open) for (const line of wrapNames(tools.active, width)) rows.push(row([seg(line, "value")]));
  return { role: "tools", title: "TOOLS", summary: `${tools.active.length}/${tools.total}`, rows };
}

/** Names two spaces apart, wrapped to the width. */
export function wrapNames(names: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const name of names) {
    const next = current === "" ? name : `${current}  ${name}`;
    if (current !== "" && visibleWidth(next) > width) {
      lines.push(current);
      current = name;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

// ---- WORKSPACE ----

function workspacePanel(snapshot: SidebarSnapshot, view: PanelView, tier: Tier, width: number): Panel {
  const { workspace } = snapshot;
  const { g } = view;
  const line = (label: string, text: string, role: Role): Row =>
    row(lr([seg(label, "label")], [seg(elideStart(text, width - visibleWidth(label) - 1, g.ellipsis), role)], width, g.ellipsis));
  const rows = [
    line("CWD", workspace.cwd || g.none, "value"),
    line("Session", workspace.sessionId ?? g.none, "value"),
    line("Storage", workspace.storage, workspace.storage === "saved" ? "ok" : "faint"),
  ];
  if (workspace.entries !== undefined) {
    const forked = workspace.branches !== undefined && workspace.branches > 1;
    const entries = forked && tier === "compact" ? String(workspace.entries) : `${workspace.entries} entries`;
    rows.push(line("History", forked ? `${entries} ${g.dot} ${workspace.branches} branches` : entries, "value"));
  }
  return { role: "workspace", title: "WORKSPACE", summary: workspace.storage, rows };
}
