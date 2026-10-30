import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToOkhsl, parseColor, rgbColor, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { PanelName } from "../src/config.ts";
import type { SidebarSnapshot } from "../src/state/snapshot.ts";
import { formatAge, formatClock, formatDuration, formatTokens } from "../src/ui/format.ts";
import { glyphsFor } from "../src/ui/glyphs.ts";
import { Palette } from "../src/ui/palette.ts";
import { buildPanel, type Tier, wrapNames } from "../src/ui/panels.ts";
import type { Action, Row } from "../src/ui/rows.ts";
import { bodyRows, headerRows, PanelsView, type SidebarModel, type SidebarView } from "../src/ui/sidebar.ts";
import { bar, elideEnd, elideStart, fit, lineWidth, seg, truncatePlain } from "../src/ui/text.ts";
import { fakeTheme, NOW, sampleSnapshot, testView } from "./helpers.ts";

/** Column width after the edge (28 - 2, 36 - 1) and the content width inside it. */
const TIERS: readonly { tier: Tier; column: number; inner: number }[] = [
  { tier: "compact", column: 26, inner: 26 },
  { tier: "normal", column: 35, inner: 31 },
];
const PANELS: readonly PanelName[] = ["session", "context", "usage", "activity", "git", "tools", "workspace"];

const rowText = (line: Row) => line.segs.map((part) => part.text).join("");

function rowsOf(snapshot: SidebarSnapshot, tier: Tier, view: SidebarView = testView(), low = false): Row[] {
  const column = tier === "compact" ? 26 : 35;
  const rows = [...headerRows(snapshot, view, tier, column, low), ...bodyRows(snapshot, view, tier, column)];
  for (const line of rows) assert.ok(lineWidth(line.segs) <= column, `${tier}: "${rowText(line)}" is wider than ${column}`);
  return rows;
}

/** The whole column as text; every line must fit its width. */
const render = (snapshot: SidebarSnapshot, tier: Tier, view?: SidebarView, low = false): string =>
  rowsOf(snapshot, tier, view, low).map(rowText).join("\n");

/** Typical data needs no truncation at either width. */
function assertFits(snapshot: SidebarSnapshot, view: SidebarView = testView()): void {
  for (const { tier, inner } of TIERS) {
    for (const name of PANELS) {
      for (const line of buildPanel(name, snapshot, view, tier, inner).rows) {
        assert.ok(lineWidth(line.segs) <= inner, `${tier} ${name}: "${rowText(line)}" is ${lineWidth(line.segs)} > ${inner}`);
      }
    }
  }
}

const contains = (text: string, parts: string[]) => {
  for (const part of parts) assert.ok(text.includes(part), `missing "${part}" in:\n${text}`);
};
const lacks = (text: string, parts: string[]) => {
  for (const part of parts) assert.ok(!text.includes(part), `unexpected "${part}" in:\n${text}`);
};

const opened = (overrides: Partial<SidebarView["expanded"]>): SidebarView => testView({ expanded: { ...testView().expanded, ...overrides } });

test("the sample data fits both widths without truncation, in unicode and ascii, open and closed", () => {
  assertFits(sampleSnapshot());
  assertFits(sampleSnapshot(), testView({}, "ascii"));
  assertFits(sampleSnapshot(), opened({ gitFiles: true, recentTools: true, toolNames: true }));
});

test("36 columns: boxed panels with the full details", () => {
  const text = render(sampleSnapshot(), "normal");
  contains(text, [
    "╭─ ✦ SESSION",
    "● READY",
    "idle 2m",
    "claude-sonnet-5-5",
    "medium",
    "anthropic",
    "metered",
    "38.2%",
    "┊",
    "76.4k / 200k",
    "+1.3k this run",
    "Auto-compact at",
    "183.6k",
    "USAGE · session",
    "182.3k",
    "hit 92%",
    "$1.284 · metered",
    "Last run · 1m12s",
    "6 turns",
    "✗ bash",
    "TTFT 1.4s",
    "41 tok/s",
    "⎇ main",
    "↑1 origin/main",
    "Changed 4 files",
    "+86 −47",
    "… 1 more",
    "M 2 · D 1 · ? 1",
    "Active 7 / 23",
    "builtin 7 · mcp 14 · ext 2",
    "~/proj/pi-sidebar",
    "0198c2e1",
    "saved",
    "46 entries · 2 branches",
  ]);
});

test("28 columns: title rules, abbreviated labels, git counts only, two tools without arguments", () => {
  const text = render(sampleSnapshot(), "compact");
  contains(text, ["✦ SESSION ─", "in 182.3k", "out 12.9k", "hit 92%", "Last run 1m12s", "✗ bash", "✓ grep", "4 changed ▸", "+86 −47", "+1.3k"]);
  lacks(text, ["╭", "anthropic", "origin/main", "Auto-compact", "src/state", "npm test", "this run"]);
});

test("context breakdown: a colour bar and one row per part, closed with a click on its first row", () => {
  const open = render(sampleSnapshot(), "normal");
  contains(open, ["▾ Breakdown", "~74.1k est", "System", "~4.2k", "5.7%", "Tool results", "~29.8k", "40.2%", "Images", "Other"]);
  lacks(open, ["Summary"]);
  const closed = render(sampleSnapshot(), "normal", opened({ breakdown: false }));
  contains(closed, ["▸ Breakdown", "~74.1k est"]);
  lacks(closed, ["Tool results", "Images"]);
  const header = rowsOf(sampleSnapshot(), "normal").find((line) => rowText(line).includes("Breakdown"));
  assert.deepEqual(header?.action, { type: "toggle", key: "breakdown" });
});

test("breakdown legend: marks that leave a gap between rows, the bar's own patterns without colour", () => {
  // "█" fills the whole cell, so the marks of stacked rows would merge into one column.
  contains(render(sampleSnapshot(), "normal"), ["■ System", "■ Tools", "■ Tool results"]);
  lacks(render(sampleSnapshot(), "normal"), ["█ System"]);
  const mono = testView({ g: glyphsFor("unicode", "mono") });
  contains(render(sampleSnapshot(), "normal", mono), ["█ System", "▓ Tools", "▒ Messages", "░ Tool results"]);
  contains(render(sampleSnapshot(), "compact", testView({}, "ascii")), ["S System", "T Tools", "R Tool results"]);
});

test("compaction off: only the bar, no threshold mark and no compact figures (D-2)", () => {
  const off = sampleSnapshot({ context: { tokens: 180_000, window: 200_000, percent: 90, compactAt: undefined } });
  for (const { tier } of TIERS) {
    const text = render(off, tier);
    contains(text, ["90.0%", "180k / 200k"]);
    lacks(text, ["┊", "Auto-compact", "near auto-compact"]);
  }
  const on = sampleSnapshot({ context: { tokens: 180_000, window: 200_000, percent: 90, compactAt: 183_616 } });
  contains(render(on, "normal"), ["┊", "Auto-compact at", "! near auto-compact threshold"]);
});

test("unknown token count after compaction, models without a context window, shrinking context", () => {
  const unknown = render(sampleSnapshot({ context: { tokens: null, window: 200_000, percent: null, compactAt: 183_616 } }), "normal");
  contains(unknown, ["?", "? / 200k", "after next reply"]);
  const none = render(sampleSnapshot({ context: undefined }), "normal");
  contains(none, ["context window unknown", "(model has no contextWindow)"]);
  const shrunk = render(sampleSnapshot({ context: { tokens: 50_000, window: 200_000, percent: 25, delta: -20_000 } }), "normal");
  contains(shrunk, ["−20k this run"]);
});

test("a running agent: spinner, turn, run clock, running tool, queued message", () => {
  const snapshot = sampleSnapshot({
    session: { ...sampleSnapshot().session, status: "working", since: NOW - 42_000, turn: 3 },
    activity: {
      ...sampleSnapshot().activity,
      running: [{ id: "r", name: "bash", summary: "npm run test:e2e", startedAt: NOW - 12_400, outcome: "running" }],
      run: { startedAt: NOW - 42_000, turns: 3 },
      queued: true,
    },
  });
  const text = render(snapshot, "normal");
  contains(text, ["WORKING · turn 3", "0:42", "▶ bash", "npm run test:e2e", "12.4s", "↳ queued message"]);
  lacks(text, ["Last run"]);
  assert.match(text, /[◐◓◑◒] WORKING/);
});

test("activity: tool counts, response speed with the run's averages, a streaming estimate, cancelled tools", () => {
  const base = sampleSnapshot().activity;
  const text = render(sampleSnapshot(), "normal");
  contains(text, ["3 ok · 1 failed", "TTFT 1.4s", "41 tok/s", "Avg 1.6s", "39 tok/s"]);
  const many = sampleSnapshot({ activity: { ...base, counts: { ok: 12, failed: 3, cancelled: 2 } } });
  contains(render(many, "compact"), ["Tools", "✓ 12  ✗ 3  ○ 2"]);
  contains(render(many, "compact", testView({}, "ascii")), ["+ 12  x 3  o 2"]);
  const live = { ttftMs: 6_100, tokensPerSecond: 18.6, speedEstimated: true, samples: { ttft: [], tps: [] } };
  const streaming = sampleSnapshot({ activity: { ...base, ...live } });
  const shown = render(streaming, "normal");
  contains(shown, ["TTFT 6.1s", "~19 tok/s"]);
  lacks(shown, ["Avg"]);
  const cancelled = sampleSnapshot({
    activity: { ...base, recent: [{ id: "c", name: "bash", summary: "sleep 60", startedAt: NOW, durationMs: 3_000, outcome: "cancelled" }] },
  });
  contains(render(cancelled, "normal"), ["○ bash"]);
  const none = { counts: { ok: 0, failed: 0, cancelled: 0 }, ttftMs: undefined, tokensPerSecond: undefined, samples: { ttft: [], tps: [] } };
  const idle = sampleSnapshot({ activity: { ...base, ...none } });
  lacks(render(idle, "normal"), [" ok", "TTFT", "Avg"]);
});

test("compacting and error states", () => {
  const base = sampleSnapshot().session;
  contains(render(sampleSnapshot({ session: { ...base, status: "compacting", since: NOW - 5_000 } }), "normal"), ["⟳ COMPACTING", "0:05"]);
  contains(render(sampleSnapshot({ session: { ...base, status: "error" } }), "compact"), ["✗ ERROR", "idle 2m"]);
});

test("commands keep their start when cut, paths their end (R-8)", () => {
  const long = sampleSnapshot({
    activity: {
      ...sampleSnapshot().activity,
      recent: [
        { id: "a", name: "bash", summary: "git status --short --branch --untracked-files=all", startedAt: NOW, durationMs: 201, outcome: "ok" },
        { id: "b", name: "read", summary: "src/very/deeply/nested/session-manager.ts", summaryIsPath: true, startedAt: NOW, durationMs: 62, outcome: "ok" },
      ],
    },
  });
  const text = render(long, "normal");
  assert.match(text, /bash {2}git status --sh[^ ]*… 201ms/);
  assert.match(text, /read {2}…\S*manager\.ts/);
  assert.equal(elideEnd("git status --short", 12), "git status …");
  assert.equal(elideStart("src/core/session-manager.ts", 18), "…ession-manager.ts");
  assert.equal(elideStart("会话管理器", 5), "…理器");
  // No reset codes inside a styled run, unlike pi-tui's truncateToWidth.
  assert.equal(truncatePlain("abcdef", 4), "abc…");
  assert.equal(truncatePlain("重构会话树", 5), "重构…");
  assert.equal(truncatePlain("abcdef", 4, "..."), "a...");
});

test("lists open and close with a click: recent tools, git files, tool names", () => {
  const closed = rowsOf(sampleSnapshot(), "normal");
  const more = closed.filter((line) => /… \d+ more/.test(rowText(line)));
  assert.deepEqual(
    more.map((line) => line.action),
    [
      { type: "toggle", key: "recentTools" },
      { type: "toggle", key: "gitFiles" },
    ],
  );
  const open = render(sampleSnapshot(), "normal", opened({ recentTools: true, gitFiles: true, toolNames: true }));
  contains(open, ["✓ ls", "? docs/notes.md", "▴ fewer", "▾ names", "read  bash  edit"]);
  const compactOpen = render(sampleSnapshot(), "compact", opened({ gitFiles: true }));
  contains(compactOpen, ["4 changed ▾", "M …/state/store.ts", "? docs/notes.md", "▴ fewer"]);
  assert.deepEqual(wrapNames(["read", "bash", "edit", "write"], 12), ["read  bash", "edit  write"]);
});

test("folded panels shrink to one line with a summary; a click on any title folds or unfolds", () => {
  const view = testView({ folded: new Set<PanelName>(["git", "usage", "session"]) });
  const rows = rowsOf(sampleSnapshot(), "normal", view);
  const text = rows.map(rowText).join("\n");
  contains(text, ["── ▸ GIT · main · 4 changed", "── ▸ USAGE · $1.284 · 195.2k", "── ▸ SESSION · READY · claude-son…"]);
  lacks(text, ["Changed 4 files", "Cache read", "refactor-session-tree"]);
  const titles = rows.filter((line) => line.action?.type === "fold").map((line) => line.action);
  assert.deepEqual(
    titles.map((action) => (action?.type === "fold" ? action.panel : "")),
    ["session", "context", "usage", "activity", "git", "tools", "workspace"],
  );
  contains(render(sampleSnapshot(), "compact", view), ["▸ GIT · main · 4 changed ─"]);
});

test("git states", () => {
  const info = sampleSnapshot().git;
  assert.equal(info.kind, "ok");
  if (info.kind !== "ok") return;
  contains(render(sampleSnapshot({ git: { kind: "loading" } }), "normal"), ["loading…"]);
  contains(render(sampleSnapshot({ git: { kind: "none" } }), "normal"), ["not a git repository"]);
  contains(render(sampleSnapshot({ git: { kind: "error", message: "slow (retry in 30s)" } }), "compact"), ["git: slow (retry in 30s)"]);
  const detached = { ...info, info: { ...info.info, branch: undefined, upstream: undefined } };
  const detachedText = render(sampleSnapshot({ git: detached }), "normal");
  contains(detachedText, ["(detached f313d56)"]);
  lacks(detachedText, ["no upstream"]);
  contains(render(sampleSnapshot({ git: { ...info, info: { ...info.info, files: [], added: 0, removed: 0 } } }), "normal"), ["clean"]);
  const noList = render(sampleSnapshot(), "normal", testView({ maxFiles: 0 }));
  contains(noList, ["… 4 more"]);
  lacks(noList, ["src/state"]);
});

test("long and wide text is cut to the column, never past it", () => {
  const long = sampleSnapshot({
    session: { ...sampleSnapshot().session, name: "重构会话树和上下文压缩逻辑的一个非常长的会话名称", model: "provider/some-extremely-long-model-identifier-v2" },
    workspace: { cwd: "~/projects/clients/very/deeply/nested/workspace/重构/pi-sidebar", sessionId: "0198c2e1", storage: "new" },
  });
  for (const { tier } of TIERS) contains(render(long, tier), ["…"]);
  assert.equal(lineWidth(fit([seg("重构会话树")], 7)), 7);
});

test("ascii icons: every line is plain ASCII", () => {
  const view = testView({}, "ascii");
  for (const { tier } of TIERS) {
    for (const line of render(sampleSnapshot(), tier, view).split("\n")) assert.match(line, /^[\x20-\x7e]*$/, `non-ASCII in "${line}"`);
  }
  contains(render(sampleSnapshot(), "normal", view), ["+- * SESSION", "* READY", "git: main", "^1 origin/main", "+86 -47", "v Breakdown"]);
});

test("panels turned off are left out; the pinned ones stay", () => {
  const view = testView({ panels: { usage: false, activity: true, git: false, tools: false, workspace: true } });
  const text = render(sampleSnapshot(), "normal", view);
  contains(text, ["SESSION", "CONTEXT", "ACTIVITY", "WORKSPACE"]);
  lacks(text, ["USAGE", "GIT", "TOOLS"]);
});

test("a low terminal merges SESSION and CONTEXT into one block", () => {
  const rows = headerRows(sampleSnapshot(), testView(), "normal", 35, true);
  const text = rows.map(rowText).join("\n");
  assert.equal(rows.length, 6);
  contains(text, ["READY", "claude-sonnet-5-5", "38.2%"]);
  lacks(text, ["CONTEXT", "refactor-session-tree", "Breakdown"]);
});

function mouse(type: TuiMouseEvent["type"], y: number, clickCount?: number): TuiMouseEvent {
  return { type, button: "left", x: 3, y, screenX: 100, screenY: y, width: 35, height: 40, shift: false, alt: false, ctrl: false, clickCount };
}

test("clicks: only rows with an action claim the press; a click runs it once; focus never moves", () => {
  const acted: Action[] = [];
  const model: SidebarModel = {
    snapshot: sampleSnapshot(),
    view: () => testView(),
    palette: () => new Palette(fakeTheme(), "theme"),
    rows: () => 40,
    renderKey: () => "k",
    invalidate() {},
    reportError: () => {},
    act: (action) => acted.push(action),
  };
  const view = new PanelsView(model, "normal", "body");
  const lines = view.render(35);
  const title = lines.findIndex((line) => line.includes("USAGE"));
  const plain = lines.findIndex((line) => line.includes("Input"));
  assert.equal(view.handleMouse(mouse("press", plain)), undefined);
  assert.deepEqual(view.handleMouse(mouse("press", title)), { handled: true, render: false });
  assert.deepEqual(view.handleMouse(mouse("click", title, 1)), { handled: true, render: true });
  assert.deepEqual(view.handleMouse(mouse("click", title, 2)), { handled: true, render: true });
  assert.deepEqual(acted, [{ type: "fold", panel: "usage" }]);
  assert.equal(view.handleMouse({ ...mouse("click", title, 1), button: "right" }), undefined);
  assert.equal(view.handleMouse(mouse("wheel", title)), undefined);
});

test("number and time formats", () => {
  assert.deepEqual([940, 76_400, 200_000, 1_000_000, 1_234_567].map(formatTokens), ["940", "76.4k", "200k", "1M", "1.2M"]);
  assert.deepEqual([12, 4_200, 72_000, 3_900_000].map(formatDuration), ["12ms", "4.2s", "1m12s", "1h5m"]);
  assert.deepEqual([30_000, 120_000, 3_600_000, 3_960_000, 90_000_000].map(formatAge), ["<1m", "2m", "1h", "1h6m", "1d1h"]);
  assert.deepEqual([42_000, 3_723_000].map(formatClock), ["0:42", "1:02:03"]);
});

/** A theme whose tokens come from `tokens` (grey otherwise); records what each paint asks for. */
function recordingTheme(tokens: Readonly<Record<string, string>>) {
  const seen: unknown[] = [];
  const theme = {
    name: "t",
    colors: new Proxy({}, { get: (_target, token) => parseColor(tokens[String(token)] ?? "#6e7680") }),
    style: (text: string, options: { fg?: unknown }) => {
      seen.push(options.fg);
      return text;
    },
    bold: (text: string) => text,
  } as unknown as Theme;
  return { theme, seen };
}

const MOCHA_TOKENS = {
  text: "#cdd6f4",
  borderMuted: "#45475a",
  mdLink: "#89b4fa",
  syntaxOperator: "#89dceb",
  syntaxType: "#f9e2af",
  syntaxString: "#a6e3a1",
  syntaxNumber: "#fab387",
  syntaxKeyword: "#cba6f7",
  syntaxVariable: "#eba0ac",
};

/** Pi's built-in dark theme (dark.json): a grey operator colour, keywords as blue as links. */
const PI_DARK_TOKENS = {
  text: "okhsl(234 3% 89%)",
  borderMuted: "okhsl(229 8% 53%)",
  mdLink: "okhsl(232 54% 67%)",
  syntaxOperator: "okhsl(229 6% 67%)",
  syntaxType: "okhsl(295 50% 67%)",
  syntaxString: "okhsl(52 67% 67%)",
  syntaxNumber: "okhsl(159 59% 67%)",
  syntaxKeyword: "okhsl(232 54% 67%)",
  syntaxVariable: "okhsl(202 58% 67%)",
};

const PANEL_ROLES = ["session", "context", "usage", "activity", "git", "workspace", "tools"] as const;

function panelColors(tokens: Readonly<Record<string, string>>, mode: "theme" | "vivid"): unknown[] {
  const { theme, seen } = recordingTheme(tokens);
  const palette = new Palette(theme, mode);
  for (const role of PANEL_ROLES) palette.paint(seg("x", role));
  return seen;
}

const hueGap = (first: number, second: number) => Math.min(Math.abs(first - second) % 360, 360 - (Math.abs(first - second) % 360));

test("palette: a theme's own panel tokens when they give seven distinct hues", () => {
  assert.deepEqual(panelColors(MOCHA_TOKENS, "theme"), [
    "mdLink",
    "syntaxOperator",
    "syntaxType",
    "syntaxString",
    "syntaxNumber",
    "syntaxKeyword",
    "syntaxVariable",
  ]);
});

test("palette: Pi's built-in themes get seven distinct hues at the theme's own lightness", () => {
  const colors = panelColors(PI_DARK_TOKENS, "theme").map((color) => colorToOkhsl(color as Color));
  for (const [index, color] of colors.entries()) {
    assert.ok(Math.abs(color.l - 0.67) < 0.02, `lightness ${color.l}`);
    assert.ok(color.s > 0.4, `saturation ${color.s}`);
    for (const other of colors.slice(0, index)) assert.ok(hueGap(color.h, other.h) >= 20, `${PANEL_ROLES[index]} is too close in hue`);
  }
});

test("palette: vivid keeps its hues on a light background, darker", () => {
  assert.deepEqual(panelColors(MOCHA_TOKENS, "vivid")[0], rgbColor(110, 168, 254));
  const light = panelColors({ ...PI_DARK_TOKENS, text: "okhsl(225 5% 27%)" }, "vivid").map((color) => colorToOkhsl(color as Color));
  for (const color of light) assert.ok(Math.abs(color.l - 0.5) < 0.02, `lightness ${color.l}`);
});

test("palette: mono and the muted breakdown part", () => {
  const { theme, seen } = recordingTheme(MOCHA_TOKENS);
  new Palette(theme, "mono").paint(seg("x", "session"));
  new Palette(theme, "theme").paint(seg("x", "part:other"));
  assert.deepEqual(seen, ["text", "muted"]);
});

test("context bar: the track colour fills the rest of the partial cell, in colour only", () => {
  const parts = bar(43.75, undefined, 10, "ok", glyphsFor("unicode", "theme").bar, 1);
  assert.deepEqual(parts, [seg("████", "ok"), { text: "▍", role: "run", bg: "track" }, seg("█████", "track")]);
  const backgrounds = (mode: "theme" | "mono") => {
    const seen: unknown[] = [];
    const theme = { ...recordingTheme(MOCHA_TOKENS).theme, style: (text: string, options: { bg?: unknown }) => (seen.push(options.bg), text) };
    new Palette(theme as Theme, mode).paint(parts[1] ?? seg(""));
    return seen;
  };
  assert.ok(backgrounds("theme")[0] !== undefined);
  assert.deepEqual(backgrounds("mono"), [undefined]);
});
