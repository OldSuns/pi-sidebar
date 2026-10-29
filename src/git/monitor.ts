import type { GitState } from "../state/snapshot.ts";
import { cleanText, errorText } from "../util.ts";
import { buildGitInfo, type LineCounts, mergeCounts, parseNumstat, parseStatus } from "./parse.ts";

/** Result of one git command, as `pi.exec` reports it. */
export interface GitRun {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type GitExec = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<GitRun>;

/**
 * Hardening for every call (SEC-1). `pi.exec` cannot set environment variables, so this relies on flags:
 * no pager, no optional locks, no fsmonitor hook, no untracked-cache writes. `status` and `diff` never
 * prompt, and `diff` runs no external diff or textconv programs.
 */
const BASE_ARGS = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
const DIFF_ARGS = ["--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-color"];

/** While the agent works, refreshes are at least this far apart (PERF-4). */
const BUSY_INTERVAL_MS = 5_000;
const IDLE_DEBOUNCE_MS = 500;
/** Command timeout (SEC-4); doubled after each timeout, up to the maximum. */
const BASE_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
/** Poll interval after timeouts doubles up to this. */
const MAX_POLL_MS = 120_000;

export interface GitOutcome {
  state: GitState;
  /** The command timed out. */
  slow: boolean;
}

/** One read-only refresh: status, then line counts against HEAD (D-10). */
export async function readGit(exec: GitExec, timeoutMs: number, signal: AbortSignal, now: () => number): Promise<GitOutcome> {
  const started = now();
  const status = await exec([...BASE_ARGS, "status", "--porcelain=v2", "-z", "--branch"], timeoutMs, signal);
  const statusFailure = classify(status);
  if (statusFailure) return statusFailure;
  const parsed = parseStatus(status.stdout);
  let counts: Map<string, LineCounts>;
  if (parsed.initial) {
    // No commit to compare with: staged changes against the empty tree, plus unstaged changes.
    const staged = await exec([...BASE_ARGS, "diff", "--cached", ...DIFF_ARGS], timeoutMs, signal);
    const unstaged = await exec([...BASE_ARGS, "diff", ...DIFF_ARGS], timeoutMs, signal);
    const failure = classify(staged) ?? classify(unstaged);
    if (failure) return failure;
    counts = mergeCounts(parseNumstat(staged.stdout), parseNumstat(unstaged.stdout));
  } else {
    const diff = await exec([...BASE_ARGS, "diff", "HEAD", ...DIFF_ARGS], timeoutMs, signal);
    const failure = classify(diff);
    if (failure) return failure;
    counts = parseNumstat(diff.stdout);
  }
  const finished = now();
  return { state: { kind: "ok", info: buildGitInfo(parsed, counts), at: finished, tookMs: finished - started }, slow: false };
}

/** Map a failed command to what the panel shows (ERR-3); undefined when it succeeded. */
export function classify(run: GitRun): GitOutcome | undefined {
  if (run.killed) return { state: { kind: "error", message: "slow" }, slow: true };
  if (run.code === 0) return undefined;
  const { stderr } = run;
  if (/not a git repository/i.test(stderr)) return { state: { kind: "none" }, slow: false };
  if (/dubious ownership|safe\.directory/i.test(stderr)) return { state: { kind: "error", message: "unsafe repository" }, slow: false };
  // pi.exec reports a command that could not start as exit code 1 with no output.
  if (run.stdout === "" && stderr === "") return { state: { kind: "error", message: "git not found" }, slow: false };
  const line = cleanText(stderr.split(/\r?\n/).find((text) => text.trim() !== "") ?? "", 120);
  return { state: { kind: "error", message: line || `exit code ${run.code}` }, slow: false };
}

export interface GitMonitorOptions {
  exec: GitExec;
  onState: (state: GitState) => void;
  pollSeconds: number;
  now?: () => number;
}

/**
 * Keeps the GIT panel current (PERF-4, SEC-4): refreshes follow events, debounced; polling runs only while
 * the panel is on screen and the agent is idle; one git process at a time; a slow repository gets longer
 * timeouts and a longer poll interval, and recovers after one fast refresh.
 */
export class GitMonitor {
  /** The latest state, for /sidebar status. */
  lastState: GitState = { kind: "loading" };
  private readonly exec: GitExec;
  private readonly onState: (state: GitState) => void;
  private readonly now: () => number;
  private pollMs: number;
  private active = false;
  private busy = false;
  private stale = true;
  private running = false;
  private again = false;
  private disposed = false;
  private noRepository = false;
  private slowStreak = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = 0;
  private controller: AbortController | undefined;

  constructor(options: GitMonitorOptions) {
    this.exec = options.exec;
    this.onState = options.onState;
    this.now = options.now ?? Date.now;
    this.pollMs = Math.max(0, options.pollSeconds) * 1000;
  }

  /** Whether the GIT panel is on screen. Inactive monitors start no git process. */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (!active) this.clearTimer();
    else if (this.stale) this.schedule(0);
    else this.schedulePoll();
  }

  /** Whether the agent is working: refreshes are spaced out and polling pauses. */
  setBusy(busy: boolean): void {
    if (this.disposed || busy === this.busy) return;
    this.busy = busy;
    if (!busy) this.schedulePoll();
  }

  setPollSeconds(seconds: number): void {
    const pollMs = Math.max(0, seconds) * 1000;
    if (pollMs === this.pollMs) return;
    this.pollMs = pollMs;
    if (!this.running) {
      this.clearTimer();
      if (this.stale) this.schedule(0);
      else this.schedulePoll();
    }
  }

  /** The working tree may have changed. */
  request(delayMs = IDLE_DEBOUNCE_MS): void {
    if (this.disposed) return;
    this.stale = true;
    // The directory may have become a repository since (`git init`).
    this.noRepository = false;
    if (this.active) this.schedule(delayMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.controller?.abort();
  }

  private schedule(delayMs: number): void {
    if (this.running) {
      this.again = true;
      return;
    }
    const now = this.now();
    const at = Math.max(now + delayMs, this.busy ? this.lastStart + BUSY_INTERVAL_MS : now);
    if (this.timer !== undefined && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, at - now);
    this.timer.unref();
  }

  private schedulePoll(): void {
    if (!this.active || this.busy || this.noRepository || this.pollMs <= 0 || this.running) return;
    this.schedule(this.pollInterval());
  }

  private pollInterval(): number {
    return Math.min(MAX_POLL_MS, this.pollMs * 2 ** this.slowStreak);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async refresh(): Promise<void> {
    if (this.disposed || !this.active || this.running) return;
    this.running = true;
    this.again = false;
    this.stale = false;
    this.lastStart = this.now();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS * 2 ** this.slowStreak);
    let outcome: GitOutcome;
    try {
      outcome = await readGit(this.exec, timeout, controller.signal, this.now);
    } catch (error) {
      outcome = { state: { kind: "error", message: cleanText(errorText(error), 120) }, slow: false };
    }
    this.running = false;
    this.controller = undefined;
    if (this.disposed) return;
    this.slowStreak = outcome.slow ? Math.min(this.slowStreak + 1, 6) : 0;
    this.noRepository = outcome.state.kind === "none";
    let state = outcome.state;
    if (outcome.slow) {
      const retry = this.pollMs > 0 ? ` (retry in ${Math.round(this.pollInterval() / 1000)}s)` : "";
      state = { kind: "error", message: `slow${retry}` };
    }
    this.lastState = state;
    this.onState(state);
    if (this.again) this.schedule(0);
    else this.schedulePoll();
  }
}
