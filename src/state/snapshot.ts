export type AgentStatus = "ready" | "working" | "compacting" | "error";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type StorageState = "saved" | "new" | "in-memory";
export type Billing = "subscription" | "metered";

export interface ToolRun {
  id: string;
  name: string;
  /** Argument summary: a path relative to the cwd, a command, a pattern. */
  summary: string;
  /** Paths keep their end when cut, commands and patterns their start (R-8). */
  summaryIsPath?: boolean;
  startedAt: number;
  /** Set once the tool has finished. */
  durationMs?: number;
  /** "cancelled": still running when the user aborted the run. */
  outcome: "running" | "ok" | "error" | "cancelled";
}

export interface RunInfo {
  startedAt: number;
  /** Undefined while the run is still going. */
  endedAt?: number;
  turns: number;
}

export interface ToolCounts {
  ok: number;
  failed: number;
  cancelled: number;
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "?" | "U";

export interface GitFile {
  status: GitFileStatus;
  path: string;
  /** Line counts against HEAD; undefined for untracked and binary files. */
  added?: number;
  removed?: number;
  binary?: boolean;
}

export interface GitInfo {
  /** Undefined for a detached HEAD. */
  branch?: string;
  /** Abbreviated commit; undefined before the first commit. */
  commit?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Conflicts first, then by changed lines. */
  files: GitFile[];
  added: number;
  removed: number;
}

export type GitState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ok"; info: GitInfo; at: number; tookMs: number }
  | { kind: "none" }
  | { kind: "error"; message: string };

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache hit rate of the latest request, in percent (D-5). */
  hitRate?: number;
}

export type PartName = "system" | "tools" | "messages" | "toolResults" | "summary" | "other";
export const PART_NAMES: readonly PartName[] = ["system", "tools", "messages", "toolResults", "summary", "other"];

/** Estimated make-up of the context (D-11): a local heuristic, not the provider's tokenizer. */
export interface Composition {
  /** Estimated tokens per part; undefined when a part could not be observed. */
  parts: Record<PartName, number | undefined>;
  total: number;
  images: number;
  /** "request": the transcript of the latest model request; "session": the active branch. */
  source: "request" | "session";
}

export interface ToolsInfo {
  /** Names of the tools declared to the model, in Pi's order. */
  active: string[];
  /** Tools that are not hidden. */
  total: number;
  builtin: number;
  mcp: number;
  extension: number;
}

/** Everything the panels draw. Render reads only this (R-2); the controller fills it from Pi events. */
export interface SidebarSnapshot {
  /** Bumped on every change; render caches key on it. */
  version: number;
  /** Time of the last change or tick; elapsed times are measured against it, so render stays pure. */
  clock: number;
  session: {
    name?: string;
    status: AgentStatus;
    /** Start of the current run or compaction, or the time the agent went idle. */
    since: number;
    /** 1-based turn of the current run. */
    turn?: number;
    model?: string;
    provider?: string;
    /** Undefined for models without reasoning. */
    thinking?: ThinkingLevel;
    billing?: Billing;
  };
  /** Undefined when Pi has no context window for the model. */
  context?: {
    /** Null right after compaction, until the next reply (F15). */
    tokens: number | null;
    window: number;
    percent: number | null;
    /** Auto-compact threshold; undefined while compaction is off (`compaction.enabled: false`). */
    compactAt?: number;
    /** Growth since the current or last run started; negative after a compaction. */
    delta?: number;
  };
  composition?: Composition;
  usage: UsageTotals;
  /** `recent` is newest first. `run` is the current run, or the last one once `endedAt` is set. */
  activity: {
    running: ToolRun[];
    recent: ToolRun[];
    run?: RunInfo;
    /** Time to the first streamed token of the latest response. */
    ttftMs?: number;
    /** Output tokens per second of the latest response, after its first token. */
    tokensPerSecond?: number;
    /** The speed is a streaming estimate; the final value replaces it when the response ends. */
    speedEstimated?: boolean;
    /** Final values of the responses of the current or last run, for the averages. */
    samples: { ttft: number[]; tps: number[] };
    /** Tools of the current or last run by outcome. */
    counts: ToolCounts;
    /** A message waits for the agent (`ctx.hasPendingMessages()`). */
    queued: boolean;
  };
  git: GitState;
  tools?: ToolsInfo;
  workspace: {
    cwd: string;
    sessionId?: string;
    storage: StorageState;
    /** Entries in the session file, all branches. */
    entries?: number;
    /** Leaves of the session tree. */
    branches?: number;
  };
}

export function emptySnapshot(now: number): SidebarSnapshot {
  return {
    version: 0,
    clock: now,
    session: { status: "ready", since: now },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    activity: { running: [], recent: [], samples: { ttft: [], tps: [] }, counts: { ok: 0, failed: 0, cancelled: 0 }, queued: false },
    git: { kind: "loading" },
    workspace: { cwd: "", storage: "in-memory" },
  };
}
