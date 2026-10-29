import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { cleanText, isRecord } from "../util.ts";
import type { SidebarSnapshot, ToolRun } from "./snapshot.ts";
import { displayPath } from "./workspace.ts";

export type Activity = SidebarSnapshot["activity"];

export const MAX_RECENT_TOOLS = 10;
/** Argument keys worth showing, in order of preference. Paths are shown relative to the cwd. */
const PATH_KEYS = ["path", "file_path", "filePath"];
const PATTERN_KEYS = ["pattern", "query", "glob"];
const TEXT_KEYS = ["command", ...PATTERN_KEYS, "url"];
/** Shortest streaming time that gives a meaningful output speed. */
const MIN_STREAMING_MS = 250;

export interface ToolStart {
  toolCallId: string;
  toolName: string;
  args: unknown;
  parentToolCallId?: string;
}

export interface ToolEnd {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  durationMs?: number;
  parentToolCallId?: string;
}

export interface ArgSummary {
  text: string;
  isPath: boolean;
}

const firstString = (args: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
};

/**
 * One-line summary of a tool's arguments: the path, the command, or "pattern in path" for searches.
 * Paths are relative to the cwd, or start with "~" under the home directory.
 */
export function summarizeArgs(args: unknown, cwd: string, home = homedir()): ArgSummary {
  if (typeof args === "string") return { text: cleanText(args), isPath: false };
  if (!isRecord(args)) return { text: "", isPath: false };
  const path = firstString(args, PATH_KEYS);
  const pattern = firstString(args, PATTERN_KEYS);
  if (path !== undefined && pattern !== undefined) return { text: cleanText(`${pattern} in ${shortPath(path, cwd, home)}`), isPath: false };
  if (path !== undefined) return { text: cleanText(shortPath(path, cwd, home)), isPath: true };
  const text = firstString(args, TEXT_KEYS) ?? firstString(args, Object.keys(args));
  return { text: text === undefined ? "" : cleanText(text), isPath: false };
}

function shortPath(path: string, cwd: string, home: string): string {
  if (cwd === "" || !isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : displayPath(path, home);
}

export function startRun(activity: Activity, now: number): Activity {
  return {
    ...activity,
    running: [],
    run: { startedAt: now, turns: 0 },
    samples: { ttft: [], tps: [] },
    counts: { ok: 0, failed: 0, cancelled: 0 },
  };
}

/** `turnIndex` counts from 0 in each run (agent-session.js `_turnIndex`). */
export function startTurn(activity: Activity, turnIndex: number): Activity {
  const { run } = activity;
  if (!run || run.endedAt !== undefined) return activity;
  return { ...activity, run: { ...run, turns: Math.max(run.turns, turnIndex + 1) } };
}

/**
 * Tools still running when the run ends never reported an end: cancelled when the user aborted the
 * run, failed otherwise.
 */
export function endRun(activity: Activity, now: number, aborted = false): Activity {
  const { run } = activity;
  const outcome: ToolRun["outcome"] = aborted ? "cancelled" : "error";
  const unfinished = activity.running.map((tool) => ({ ...tool, outcome, durationMs: Math.max(0, now - tool.startedAt) }));
  const counts = { ...activity.counts };
  if (aborted) counts.cancelled += unfinished.length;
  else counts.failed += unfinished.length;
  return {
    ...activity,
    running: [],
    recent: [...unfinished, ...activity.recent].slice(0, MAX_RECENT_TOOLS),
    counts,
    run: run && run.endedAt === undefined ? { ...run, endedAt: now } : run,
  };
}

/** Nested calls (a tool calling tools) are shown as part of their parent. */
export function startTool(activity: Activity, event: ToolStart, now: number, cwd: string): Activity {
  if (event.parentToolCallId) return activity;
  const summary = summarizeArgs(event.args, cwd);
  const tool: ToolRun = {
    id: event.toolCallId,
    name: cleanText(event.toolName, 40),
    summary: summary.text,
    summaryIsPath: summary.isPath,
    startedAt: now,
    outcome: "running",
  };
  return { ...activity, running: [...activity.running.filter((run) => run.id !== tool.id), tool] };
}

export function endTool(activity: Activity, event: ToolEnd, now: number): Activity {
  if (event.parentToolCallId) return activity;
  const started = activity.running.find((run) => run.id === event.toolCallId);
  const done: ToolRun = {
    id: event.toolCallId,
    name: started?.name ?? cleanText(event.toolName, 40),
    summary: started?.summary ?? "",
    summaryIsPath: started?.summaryIsPath ?? false,
    startedAt: started?.startedAt ?? now,
    durationMs: event.durationMs ?? (started ? now - started.startedAt : 0),
    outcome: event.isError ? "error" : "ok",
  };
  const counts = { ...activity.counts };
  if (event.isError) counts.failed++;
  else counts.ok++;
  return {
    ...activity,
    running: activity.running.filter((run) => run.id !== event.toolCallId),
    recent: [done, ...activity.recent].slice(0, MAX_RECENT_TOOLS),
    counts,
  };
}

/** Output speed after the first token; undefined for very short or empty responses. */
export function tokensPerSecond(outputTokens: number, streamingMs: number): number | undefined {
  if (!(outputTokens > 0) || !(streamingMs >= MIN_STREAMING_MS)) return undefined;
  return outputTokens / (streamingMs / 1000);
}

/** The first token of a response: its TTFT; the speed of the previous response no longer applies. */
export function firstToken(activity: Activity, ttftMs: number): Activity {
  return { ...activity, ttftMs, tokensPerSecond: undefined, speedEstimated: undefined };
}

/** A streaming estimate of the output speed, shown as "~". */
export function streamingSpeed(activity: Activity, speed: number): Activity {
  return { ...activity, tokensPerSecond: speed, speedEstimated: true };
}

/** The response ended: the final speed from its usage, and both values join the run's averages. */
export function responseDone(activity: Activity, ttftMs: number | undefined, speed: number | undefined): Activity {
  const samples = {
    ttft: ttftMs === undefined ? activity.samples.ttft : [...activity.samples.ttft, ttftMs],
    tps: speed === undefined ? activity.samples.tps : [...activity.samples.tps, speed],
  };
  return speed === undefined
    ? { ...activity, samples, tokensPerSecond: activity.speedEstimated ? activity.tokensPerSecond : undefined }
    : { ...activity, samples, tokensPerSecond: speed, speedEstimated: false };
}

export function average(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}
