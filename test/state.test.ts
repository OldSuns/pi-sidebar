import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  average,
  endRun,
  endTool,
  firstToken,
  MAX_RECENT_TOOLS,
  responseDone,
  startRun,
  startTool,
  startTurn,
  streamingSpeed,
  summarizeArgs,
  tokensPerSecond,
} from "../src/state/activity.ts";
import type { PiSettings } from "../src/state/context.ts";
import { compactionThreshold } from "../src/state/context.ts";
import { idleFlags, lastActivity, readBilling, readModel, statusOf } from "../src/state/session.ts";
import type { SidebarSnapshot } from "../src/state/snapshot.ts";
import { readTools } from "../src/state/tools.ts";
import { scanUsage, startScan } from "../src/state/usage.ts";
import { countBranches, displayPath, storageState } from "../src/state/workspace.ts";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const ENTRIES: unknown[] = [
  { type: "message", message: { role: "user", content: "hi" } },
  { type: "message", message: { role: "assistant", usage: usage(100, 20, 300, 50, 0.01) } },
  { type: "message", message: { role: "toolResult", usage: usage(10, 5, 0, 0, 0.001) } },
  { type: "message", message: { role: "toolResult" } },
  { type: "usage", usage: usage(7, 3, 0, 0, 0.002) },
  { type: "compaction", usage: usage(40, 10, 0, 0, 0.003) },
  { type: "branch_summary", usage: usage(1, 1, 0, 0, 0) },
  { type: "label", label: "x" },
];

test("usage: the same entries and fields as Pi's footer", () => {
  const { totals, scanned } = scanUsage(ENTRIES, startScan());
  assert.equal(scanned, ENTRIES.length);
  assert.equal(totals.input, 158);
  assert.equal(totals.output, 39);
  assert.equal(totals.cacheRead, 300);
  assert.equal(totals.cacheWrite, 50);
  assert.ok(Math.abs(totals.cost - 0.016) < 1e-12);
  assert.ok(Math.abs((totals.hitRate ?? 0) - (300 / 450) * 100) < 1e-9);
});

test("usage: scanning in steps equals one scan, and a shorter list starts over", () => {
  const stepped = scanUsage(ENTRIES, scanUsage(ENTRIES.slice(0, 3), startScan()));
  assert.deepEqual(stepped, scanUsage(ENTRIES, startScan()));
  const restarted = scanUsage(ENTRIES.slice(0, 2), stepped);
  assert.equal(restarted.totals.input, 100);
  assert.equal(restarted.scanned, 2);
});

test("usage: the hit rate follows the latest assistant message", () => {
  const entries = [...ENTRIES, { type: "message", message: { role: "assistant", usage: usage(10, 1, 0, 0, 0) } }];
  assert.equal(scanUsage(entries, startScan()).totals.hitRate, 0);
});

const idleActivity = (): SidebarSnapshot["activity"] => ({
  running: [],
  recent: [],
  samples: { ttft: [], tps: [] },
  counts: { ok: 0, failed: 0, cancelled: 0 },
  queued: false,
});

test("activity: tools run, finish, and the newest stays first", () => {
  let activity = idleActivity();
  activity = startRun(activity, 1000);
  activity = startTurn(activity, 0);
  activity = startTool(activity, { toolCallId: "a", toolName: "bash", args: { command: "npm test" } }, 1100, "");
  activity = startTool(activity, { toolCallId: "n", toolName: "read", args: {}, parentToolCallId: "a" }, 1150, "");
  assert.deepEqual(activity.running.map((tool) => tool.name), ["bash"]);
  activity = startTurn(activity, 2);
  activity = endTool(activity, { toolCallId: "a", toolName: "bash", isError: true }, 1600);
  assert.deepEqual(activity.recent[0], {
    id: "a",
    name: "bash",
    summary: "npm test",
    summaryIsPath: false,
    startedAt: 1100,
    durationMs: 500,
    outcome: "error",
  });
  assert.equal(activity.running.length, 0);
  activity = endRun(activity, 2000);
  assert.deepEqual(activity.run, { startedAt: 1000, endedAt: 2000, turns: 3 });
  for (let index = 0; index < 15; index++) {
    activity = endTool(activity, { toolCallId: `t${index}`, toolName: "read", isError: false, durationMs: 1 }, 3000);
  }
  assert.equal(activity.recent.length, MAX_RECENT_TOOLS);
  assert.equal(activity.recent[0]?.id, "t14");
  assert.deepEqual(activity.counts, { ok: 15, failed: 1, cancelled: 0 });
});

test("activity: tools still running at the end of a run are cancelled on abort, failed otherwise", () => {
  let activity = startRun(idleActivity(), 1000);
  activity = startTool(activity, { toolCallId: "a", toolName: "bash", args: { command: "sleep 60" } }, 1100, "");
  const aborted = endRun(activity, 1600, true);
  assert.equal(aborted.running.length, 0);
  assert.deepEqual([aborted.recent[0]?.outcome, aborted.recent[0]?.durationMs], ["cancelled", 500]);
  assert.deepEqual(aborted.counts, { ok: 0, failed: 0, cancelled: 1 });
  const failed = endRun(activity, 1600);
  assert.equal(failed.recent[0]?.outcome, "error");
  assert.deepEqual(failed.counts, { ok: 0, failed: 1, cancelled: 0 });
  // The next run counts afresh; the recent tools stay.
  const next = startRun({ ...aborted, samples: { ttft: [900], tps: [30] } }, 2000);
  assert.deepEqual(next.counts, { ok: 0, failed: 0, cancelled: 0 });
  assert.deepEqual(next.samples, { ttft: [], tps: [] });
  assert.equal(next.recent.length, 1);
});

test("activity: argument summaries are one clean line, paths relative to the cwd or the home directory", () => {
  const root = process.cwd();
  const cwd = join(root, "proj");
  const home = join(root, "home");
  const summary = (args: unknown) => summarizeArgs(args, cwd, home);
  assert.deepEqual(summary({ path: join(cwd, "src", "a.ts") }), { text: join("src", "a.ts"), isPath: true });
  assert.deepEqual(summary({ path: join(root, "elsewhere.ts") }), { text: join(root, "elsewhere.ts"), isPath: true });
  assert.deepEqual(summary({ path: join(home, "notes.md") }), { text: join("~", "notes.md"), isPath: true });
  assert.deepEqual(summary({ command: "npm test\n  --watch\u001b[2J" }), { text: "npm test --watch", isPath: false });
  // Searches read as "pattern in path".
  assert.deepEqual(summary({ pattern: "TODO", path: join(cwd, "src") }), { text: "TODO in src", isPath: false });
  assert.equal(summary({ limit: 3, query: "needle" }).text, "needle");
  assert.equal(summary({ custom: "value" }).text, "value");
  assert.equal(summary(undefined).text, "");
});

test("output speed needs a response that streamed for a moment", () => {
  assert.equal(tokensPerSecond(120, 3_000), 40);
  assert.equal(tokensPerSecond(120, 100), undefined);
  assert.equal(tokensPerSecond(0, 3_000), undefined);
});

test("response speed: first token, streaming estimate, final value, and the run's averages", () => {
  let activity = startRun(idleActivity(), 0);
  activity = firstToken({ ...activity, tokensPerSecond: 50, speedEstimated: false }, 1_200);
  assert.deepEqual([activity.ttftMs, activity.tokensPerSecond], [1_200, undefined]);
  activity = streamingSpeed(activity, 30);
  assert.deepEqual([activity.tokensPerSecond, activity.speedEstimated], [30, true]);
  activity = responseDone(activity, 1_200, 40);
  assert.deepEqual([activity.tokensPerSecond, activity.speedEstimated], [40, false]);
  // Too short for a final speed: the estimate stays, and only the TTFT joins the averages.
  activity = responseDone(streamingSpeed(firstToken(activity, 800), 25), 800, undefined);
  assert.deepEqual([activity.tokensPerSecond, activity.speedEstimated], [25, true]);
  assert.deepEqual(activity.samples, { ttft: [1_200, 800], tps: [40] });
  assert.equal(average(activity.samples.ttft), 1_000);
  assert.equal(average([]), undefined);
  // No estimate and no final value: no speed.
  assert.equal(responseDone(firstToken(activity, 500), 500, undefined).tokensPerSecond, undefined);
});

test("tools: active against all visible tools, grouped by origin", () => {
  const info = readTools(
    ["read", "bash", "read", "mcp__docs__search"],
    [
      { name: "read", exposure: "direct", sourceInfo: { path: "builtin:read" } },
      { name: "bash", exposure: "direct", sourceInfo: { path: "builtin:bash" } },
      { name: "mcp__docs__search", exposure: "deferred", namespace: { name: "mcp__docs" }, sourceInfo: { path: "builtin:mcp" } },
      { name: "todo", exposure: "direct", sourceInfo: { path: "C:/ext/todo/index.ts" } },
      { name: "secret", exposure: "hidden", sourceInfo: { path: "builtin:secret" } },
    ],
  );
  assert.deepEqual(info, { active: ["read", "bash", "mcp__docs__search"], total: 4, builtin: 2, mcp: 1, extension: 1 });
});

const settings = (compaction: unknown) => ({ compaction }) as PiSettings;
const model = { provider: "anthropic", id: "claude" } as Parameters<typeof compactionThreshold>[1];

test("compaction threshold follows Pi's own rule (D-2)", () => {
  assert.equal(compactionThreshold(settings(undefined), model, 200_000), 200_000 - 16_384);
  assert.equal(compactionThreshold(settings({ enabled: false, reserveTokens: 1000 }), model, 200_000), undefined);
  assert.equal(compactionThreshold(settings({ reserveTokens: 20_000 }), model, 200_000), 180_000);
  const overrides = { reserveTokens: 20_000, modelOverrides: { "anthropic/claude": { reserveTokens: 50_000 } } };
  assert.equal(compactionThreshold(settings(overrides), model, 200_000), 150_000);
  assert.equal(compactionThreshold(settings(overrides), { ...model, id: "other" } as typeof model, 200_000), 180_000);
  assert.equal(compactionThreshold(settings({ reserveTokens: 300_000 }), model, 200_000), undefined);
});

test("status follows the agent: compacting, working, error, ready", () => {
  const idle = idleFlags(100);
  assert.deepEqual(statusOf(idle), { status: "ready", since: 100, turn: undefined });
  assert.deepEqual(statusOf({ ...idle, running: true, runStartedAt: 200, turn: 3 }), { status: "working", since: 200, turn: 3 });
  assert.deepEqual(statusOf({ ...idle, running: true, compacting: true, compactStartedAt: 300 }), { status: "compacting", since: 300, turn: undefined });
  assert.equal(statusOf({ ...idle, outcome: "error" }).status, "error");
  assert.equal(statusOf({ ...idle, outcome: "aborted" }).status, "ready");
});

test("model info shows the thinking level only for reasoning models; billing from the OAuth check", () => {
  const reasoning = { id: "m", provider: "p", reasoning: true } as Parameters<typeof readModel>[0];
  assert.deepEqual(readModel(reasoning, "high"), { model: "m", provider: "p", thinking: "high" });
  assert.equal(readModel({ ...reasoning, reasoning: false } as typeof reasoning, "high").thinking, undefined);
  assert.equal(readModel(reasoning, "bogus").thinking, undefined);
  assert.deepEqual(readModel(undefined, "high"), { model: undefined, provider: undefined, thinking: undefined });
  const registry = (oauth: boolean) => ({ isUsingOAuth: () => oauth }) as unknown as Parameters<typeof readBilling>[0]["modelRegistry"];
  assert.equal(readBilling({ model: reasoning, modelRegistry: registry(true) }), "subscription");
  assert.equal(readBilling({ model: reasoning, modelRegistry: registry(false) }), "metered");
  assert.equal(readBilling({ model: undefined, modelRegistry: registry(true) }), undefined);
});

test("idle time of a resumed session starts at its newest entry", () => {
  assert.equal(lastActivity([{ timestamp: "2026-10-28T10:00:00Z" }, { timestamp: "2026-10-28T11:00:00Z" }]), Date.parse("2026-10-28T11:00:00Z"));
  assert.equal(lastActivity([]), undefined);
});

test("workspace: home shortened to ~, storage state (D-7), branches of the session tree", () => {
  assert.equal(displayPath("/home/me/proj", "/home/me", false), "~/proj");
  assert.equal(displayPath("/home/me", "/home/me/", false), "~");
  assert.equal(displayPath("/home/meadow", "/home/me", false), "/home/meadow");
  assert.equal(displayPath("C:\\Users\\Me\\Proj", "c:\\users\\me", true), "~\\Proj");
  assert.equal(storageState(undefined, ENTRIES), "in-memory");
  assert.equal(storageState("s.jsonl", [{ type: "label" }]), "new");
  assert.equal(storageState("s.jsonl", ENTRIES), "saved");
  const leaf = { children: [] };
  assert.equal(countBranches([{ children: [{ children: [leaf, leaf] }, leaf] }]), 3);
  assert.equal(countBranches([]), 0);
});
