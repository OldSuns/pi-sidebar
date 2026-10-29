import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { SidebarController } from "../src/controller.ts";
import { fallbackEstimate, toolTokens } from "../src/state/composition.ts";
import { fakeTheme } from "./helpers.ts";

const START = 1_800_000_000_000;

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 300,
  cacheWrite: 50,
  totalTokens: input + output + 350,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
});

const assistant = (chars: number) => ({ role: "assistant", content: [{ type: "text", text: "a".repeat(chars) }] });

const TOOLS = [
  { name: "read", description: "Read a file", parameters: {}, exposure: "direct", sourceInfo: { path: "builtin:read" } },
  { name: "bash", description: "Run a command", parameters: {}, exposure: "direct", sourceInfo: { path: "builtin:bash" } },
  { name: "todo", description: "A todo list", parameters: {}, exposure: "direct", sourceInfo: { path: "/ext/todo/index.ts" } },
];

let dir = "";

beforeEach(() => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  dir = mkdtempSync(join(tmpdir(), "pi-sidebar-controller-"));
});

afterEach(() => {
  mock.timers.reset();
  rmSync(dir, { recursive: true, force: true });
});

/** A controller with fake Pi objects: what it reads, and what it does to Pi (widgets, notices, git). */
function harness(mode = "tui") {
  const configFile = join(dir, "pi-sidebar.json");
  const widgets: unknown[][] = [];
  const execs: unknown[][] = [];
  const estimates = { calls: 0 };
  const state = {
    entries: [
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", usage: usage(100, 20) } },
    ] as unknown[],
    messages: [{ role: "user", content: "u".repeat(40) }, assistant(80)] as unknown[],
    failEntries: false,
    pending: false,
  };
  const model = { id: "claude-test", provider: "anthropic", reasoning: true, contextWindow: 200_000 };
  const ctx = {
    mode,
    cwd: dir,
    model,
    modelRegistry: { isUsingOAuth: () => false },
    ui: { setWidget: (...args: unknown[]) => widgets.push(args), notify: () => undefined },
    sessionManager: {
      getEntries: () => {
        if (state.failEntries) throw new Error("disk gone");
        return state.entries;
      },
      getSessionId: () => "0198c2e1-7f00-7000-8000-000000000000",
      getSessionFile: () => join(dir, "session.jsonl"),
      getTree: () => [{ children: [{ children: [] }, { children: [] }] }],
      buildSessionProjection: () => ({ messages: state.messages }),
    },
    getContextUsage: () => ({ tokens: 30_000, contextWindow: 200_000, percent: 15 }),
    getSystemPrompt: () => "s".repeat(400),
    hasPendingMessages: () => state.pending,
  } as unknown as ExtensionContext;
  const pi = {
    exec: async (...args: unknown[]) => {
      execs.push(args);
      return { code: 1, stdout: "", stderr: "", killed: false };
    },
    getSessionName: () => "refactor",
    getThinkingLevel: () => "medium",
    getSettings: () => ({ compaction: { enabled: false } }),
    getActiveTools: () => ["read", "bash"],
    getAllTools: () => TOOLS,
  } as unknown as ExtensionAPI;
  const controller = new SidebarController(pi, {
    configFile,
    estimateTokens: (message) => {
      estimates.calls++;
      return fallbackEstimate(message);
    },
  });
  return { controller, ctx, widgets, execs, estimates, state, configFile };
}

test("outside the TUI the sidebar adds nothing and ignores events", () => {
  const { controller, ctx, widgets, execs } = harness("print");
  controller.start(ctx);
  controller.onAgentStart(ctx);
  controller.onToolStart({ toolCallId: "a", toolName: "bash", args: { command: "ls" } });
  controller.onMessageUpdate(assistant(40));
  controller.shutdown(ctx);
  assert.deepEqual(widgets, []);
  assert.deepEqual(execs, []);
  assert.equal(controller.snapshot.version, 0);
  assert.deepEqual(controller.errors, []);
});

test("session_start reads the session and adds only the zero-line probe below the editor", () => {
  const { controller, ctx, widgets } = harness();
  controller.start(ctx);
  assert.equal(widgets.length, 1);
  assert.deepEqual([widgets[0]?.[0], typeof widgets[0]?.[1], widgets[0]?.[2]], ["pi-sidebar:host", "function", { placement: "belowEditor" }]);
  const { session, usage: totals, context, composition, tools, workspace } = controller.snapshot;
  assert.deepEqual(
    [session.name, session.status, session.model, session.provider, session.thinking, session.billing],
    ["refactor", "ready", "claude-test", "anthropic", "medium", "metered"],
  );
  assert.deepEqual([totals.input, totals.output, totals.cacheRead, totals.cacheWrite], [100, 20, 300, 50]);
  // Compaction is off in these settings: no threshold (D-2).
  assert.deepEqual(context, { tokens: 30_000, window: 200_000, percent: 15, compactAt: undefined });
  assert.equal(composition?.source, "session");
  assert.deepEqual([composition?.parts.system, composition?.parts.tools, composition?.parts.messages], [100, toolTokens(TOOLS.slice(0, 2)), 30]);
  assert.deepEqual(tools, { active: ["read", "bash"], total: 3, builtin: 2, mcp: 0, extension: 1 });
  assert.deepEqual([workspace.sessionId, workspace.entries, workspace.branches], ["0198c2e1", 2, 2]);
  assert.deepEqual(controller.errors, []);
});

test("a run: tools, time to first token, a sampled streaming estimate, final speeds, averages, cancelled tools", () => {
  const { controller, ctx, estimates } = harness();
  controller.start(ctx);
  controller.onAgentStart(ctx);
  controller.onTurnStart(0, ctx);
  assert.deepEqual([controller.snapshot.session.status, controller.snapshot.session.turn], ["working", 1]);

  controller.onProviderRequest();
  mock.timers.tick(500);
  // An update without output yet does not stop the TTFT clock.
  controller.onMessageUpdate({ role: "assistant", content: [] });
  assert.equal(controller.snapshot.activity.ttftMs, undefined);
  mock.timers.tick(700);
  controller.onMessageUpdate(assistant(40));
  assert.equal(controller.snapshot.activity.ttftMs, 1_200);
  mock.timers.tick(1_000);
  controller.onMessageUpdate(assistant(160));
  assert.deepEqual([controller.snapshot.activity.tokensPerSecond, controller.snapshot.activity.speedEstimated], [40, true]);
  // Updates within 150 ms of the last sample are not even estimated.
  const calls = estimates.calls;
  mock.timers.tick(50);
  controller.onMessageUpdate(assistant(400));
  assert.equal(estimates.calls, calls);
  mock.timers.tick(950);
  controller.onMessageEnd({ ...assistant(400), usage: usage(10, 100) }, ctx);
  assert.deepEqual([controller.snapshot.activity.tokensPerSecond, controller.snapshot.activity.speedEstimated], [50, false]);

  controller.onToolStart({ toolCallId: "t1", toolName: "read", args: { path: join(dir, "src", "a.ts") } });
  mock.timers.tick(30);
  controller.onToolEnd({ toolCallId: "t1", toolName: "read", isError: false });
  controller.onTurnStart(1, ctx);
  controller.onProviderRequest();
  mock.timers.tick(800);
  controller.onMessageUpdate(assistant(8));
  mock.timers.tick(1_000);
  controller.onMessageEnd({ ...assistant(8), usage: usage(10, 30) }, ctx);
  controller.onToolStart({ toolCallId: "t2", toolName: "bash", args: { command: "sleep 60" } });
  mock.timers.tick(2_000);
  controller.onBeforeSettle("aborted");
  controller.onAgentSettled(true, ctx);

  const { activity, session } = controller.snapshot;
  assert.equal(session.status, "ready");
  assert.deepEqual(activity.samples, { ttft: [1_200, 800], tps: [50, 30] });
  assert.deepEqual(activity.counts, { ok: 1, failed: 0, cancelled: 1 });
  assert.deepEqual(
    activity.recent.map((tool) => [tool.name, tool.summary, tool.outcome, tool.durationMs]),
    [
      ["bash", "sleep 60", "cancelled", 2_000],
      ["read", join("src", "a.ts"), "ok", 30],
    ],
  );
  assert.deepEqual(activity.run, { startedAt: START, endedAt: START + 7_030, turns: 2 });
  assert.deepEqual(controller.errors, []);
});

test("the breakdown follows the latest request, and between requests keeps that request's prompt and tools", () => {
  const { controller, ctx } = harness();
  controller.start(ctx);
  controller.onRequestContext([
    { role: "system", content: "p".repeat(800), toolsAdded: [{ name: "read", description: "Read a file", parameters: {} }] },
    { role: "user", content: "u".repeat(40) },
  ]);
  const request = controller.snapshot.composition;
  assert.deepEqual([request?.source, request?.parts.system, request?.parts.messages], ["request", 200, 10]);
  controller.onTurnEnd(ctx);
  const session = controller.snapshot.composition;
  assert.deepEqual([session?.source, session?.parts.system, session?.parts.tools, session?.parts.messages], ["session", 200, request?.parts.tools, 30]);
});

test("a failing read is reported and leaves the rest of the snapshot current", () => {
  const { controller, ctx, state } = harness();
  controller.start(ctx);
  state.failEntries = true;
  state.messages = [...state.messages, { role: "user", content: "v".repeat(40) }];
  assert.doesNotThrow(() => controller.onTurnEnd(ctx));
  assert.match(controller.errors.at(-1) ?? "", /read entries: disk gone/);
  assert.equal(controller.snapshot.composition?.parts.messages, 40);
  assert.equal(controller.snapshot.usage.input, 100);
  assert.match(controller.statusText(), /^errors {3}.*read entries: disk gone/m);
});

test("model, thinking level, session name and queued input follow their events", () => {
  const { controller, ctx } = harness();
  controller.start(ctx);
  controller.onModelSelect({ id: "small", provider: "local", reasoning: false, contextWindow: 32_000 } as ExtensionContext["model"], ctx);
  const { session } = controller.snapshot;
  assert.deepEqual([session.model, session.provider, session.thinking], ["small", "local", undefined]);
  controller.onThinkingSelect("high", ctx);
  assert.equal(controller.snapshot.session.thinking, "high");
  controller.onSessionInfo("  release\n notes\u001b[2J ");
  assert.equal(controller.snapshot.session.name, "release notes");
  controller.onInput(false);
  assert.equal(controller.snapshot.activity.queued, false);
  controller.onInput(true);
  assert.equal(controller.snapshot.activity.queued, true);
});

test("clicks: folds and the breakdown are saved, opened lists last only the session", () => {
  const { controller, ctx, configFile } = harness();
  controller.start(ctx);
  controller.act({ type: "fold", panel: "git" });
  controller.act({ type: "toggle", key: "breakdown" });
  controller.act({ type: "toggle", key: "gitFiles" });
  const saved = JSON.parse(readFileSync(configFile, "utf8"));
  assert.deepEqual(saved, { folded: ["git"], contextBreakdown: false });
  const view = controller.view();
  assert.deepEqual([view.folded.has("git"), view.expanded.breakdown, view.expanded.gitFiles], [true, false, true]);
  controller.act({ type: "fold", panel: "git" });
  assert.equal(controller.view().folded.has("git"), false);
  controller.start(ctx);
  assert.equal(controller.view().expanded.gitFiles, false);
  assert.deepEqual(controller.errors, []);
});

/** Pi's fullscreen renderer as the probe widget sees it: a viewport TUI with a layout root. */
function fakeTui(columns: number, rows: number) {
  const tui = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    mode: "fullscreen",
    layoutRoot: new VStack([{ render: (width: number) => ["transcript".padEnd(width)], invalidate() {} }]) as Component,
    terminal: { columns, rows },
    setLayoutRoot(component: Component) {
      tui.layoutRoot = component;
    },
    requestRender() {},
  };
  return tui;
}

const microtasks = () => new Promise((resolve) => setImmediate(resolve));

test("git runs once the sidebar is on screen, and starts no process with its panel off", async () => {
  const { controller, ctx, widgets, execs } = harness();
  controller.start(ctx);
  const tui = fakeTui(160, 40);
  (widgets[0]?.[1] as (tui: unknown, theme: unknown) => unknown)(tui, fakeTheme());
  await microtasks();
  assert.ok(tui.layoutRoot instanceof HStack, "the layout root is wrapped");
  // Nothing runs before the first frame puts the sidebar on screen.
  mock.timers.tick(60_000);
  assert.deepEqual(execs, []);
  const frame = renderLayoutFrame(tui.layoutRoot, 160, 40, () => {});
  assert.equal(frame.root.children[0]?.rect.width, 124);
  for (let step = 0; step < 3; step++) {
    mock.timers.tick(0);
    await microtasks();
  }
  assert.ok(execs.length > 0, "a refresh ran");
  assert.equal(execs[0]?.[0], "git");
  assert.match(controller.statusText(), /mounted · visible/);

  execs.length = 0;
  assert.match(controller.setPanel("git", false), /no git processes will be started/);
  controller.onToolEnd({ toolCallId: "e", toolName: "edit", isError: false });
  controller.onAgentSettled(false, ctx);
  mock.timers.tick(60_000);
  await microtasks();
  assert.equal(controller.snapshot.git.kind, "off");
  assert.deepEqual(execs, []);
  controller.shutdown(ctx);
  assert.ok(!(tui.layoutRoot instanceof HStack), "Pi's own root is back");
});

test("session_shutdown takes the probe away and later events change nothing", () => {
  const { controller, ctx, widgets } = harness();
  controller.start(ctx);
  controller.shutdown(ctx);
  assert.deepEqual(widgets.at(-1), ["pi-sidebar:host", undefined]);
  const { version } = controller.snapshot;
  controller.onAgentStart(ctx);
  controller.onProviderRequest();
  controller.onMessageUpdate(assistant(40));
  controller.onAgentSettled(false, ctx);
  assert.equal(controller.snapshot.version, version);
});
