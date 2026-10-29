import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";
import { defaultConfig, type IconMode } from "../src/config.ts";
import type { SidebarSnapshot } from "../src/state/snapshot.ts";
import { glyphsFor } from "../src/ui/glyphs.ts";
import type { SidebarView } from "../src/ui/sidebar.ts";

export const NOW = Date.parse("2026-10-28T12:00:00Z");

/** Stands in for Pi's theme: one colour for every token, and styling as real SGR codes. */
export function fakeTheme(name = "test-theme"): Theme {
  const colors = new Proxy({}, { get: () => rgbColor(120, 130, 140) });
  const theme = {
    name,
    colors,
    style: (text: string, options: { bold?: boolean }) => `\u001b[38;5;2m${options.bold ? "\u001b[1m" : ""}${text}\u001b[0m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  };
  return theme as unknown as Theme;
}

export function testView(overrides: Partial<SidebarView> = {}, icons: IconMode = "unicode"): SidebarView {
  return {
    g: glyphsFor(icons, "theme"),
    warnPercent: 70,
    dangerPercent: 85,
    recentTools: 3,
    maxFiles: 3,
    expanded: { breakdown: true, gitFiles: false, recentTools: false, toolNames: false },
    panels: defaultConfig().panels,
    folded: new Set(),
    ...overrides,
  };
}

/** The data of the design mockups, plus the features that came after them. */
export function sampleSnapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
  return {
    version: 1,
    clock: NOW,
    session: {
      name: "refactor-session-tree",
      status: "ready",
      since: NOW - 120_000,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      thinking: "medium",
      billing: "metered",
    },
    context: { tokens: 76_400, window: 200_000, percent: 38.2, compactAt: 183_616, delta: 1_300 },
    composition: {
      parts: { system: 4_200, tools: 8_100, messages: 32_000, toolResults: 29_800, summary: 0, other: 40 },
      total: 74_140,
      images: 2,
      source: "request",
    },
    usage: { input: 182_300, output: 12_900, cacheRead: 640_100, cacheWrite: 41_200, cost: 1.284, hitRate: 92.4 },
    activity: {
      running: [],
      recent: [
        { id: "3", name: "bash", summary: "npm test -- --watch=false", startedAt: NOW - 78_000, durationMs: 4_200, outcome: "error" },
        { id: "2", name: "grep", summary: "getBranch", startedAt: NOW - 79_000, durationMs: 31, outcome: "ok" },
        { id: "1", name: "read", summary: "src/core/session-manager.ts", summaryIsPath: true, startedAt: NOW - 80_000, durationMs: 12, outcome: "ok" },
        { id: "0", name: "ls", summary: "src", summaryIsPath: true, startedAt: NOW - 81_000, durationMs: 3, outcome: "ok" },
      ],
      run: { startedAt: NOW - 150_000, endedAt: NOW - 78_000, turns: 6 },
      ttftMs: 1_400,
      tokensPerSecond: 41.2,
      samples: { ttft: [2_600, 1_200, 1_500, 1_300, 1_700, 1_400], tps: [32, 38.5, 44.1, 36.7, 40.3, 41.2] },
      counts: { ok: 3, failed: 1, cancelled: 0 },
      queued: false,
    },
    git: {
      kind: "ok",
      at: NOW,
      tookMs: 38,
      info: {
        branch: "main",
        commit: "f313d56",
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        added: 86,
        removed: 47,
        files: [
          { status: "M", path: "src/state/store.ts", added: 41, removed: 12 },
          { status: "M", path: "src/ui/panels/git.ts", added: 38, removed: 27 },
          { status: "D", path: "old.txt", added: 0, removed: 4 },
          { status: "?", path: "docs/notes.md" },
        ],
      },
    },
    tools: { active: ["read", "bash", "edit", "write", "grep", "find", "ls"], total: 23, builtin: 7, mcp: 14, extension: 2 },
    workspace: { cwd: "~/proj/pi-sidebar", sessionId: "0198c2e1", storage: "saved", entries: 46, branches: 2 },
    ...overrides,
  };
}
