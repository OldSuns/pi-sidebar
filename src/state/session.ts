import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText, isRecord } from "../util.ts";
import { type Billing, type SidebarSnapshot, THINKING_LEVELS, type ThinkingLevel } from "./snapshot.ts";

export type RunOutcome = "completed" | "aborted" | "error";

/** What the agent is doing, tracked from agent and compaction events. */
export interface AgentFlags {
  running: boolean;
  compacting: boolean;
  /** How the last run ended (`agent_before_settle`). */
  outcome?: RunOutcome;
  runStartedAt: number;
  compactStartedAt: number;
  idleSince: number;
  /** 1-based turn of the current run. */
  turn?: number;
}

export function idleFlags(idleSince: number): AgentFlags {
  return { running: false, compacting: false, runStartedAt: idleSince, compactStartedAt: idleSince, idleSince };
}

export function statusOf(flags: AgentFlags): Pick<SidebarSnapshot["session"], "status" | "since" | "turn"> {
  if (flags.compacting) return { status: "compacting", since: flags.compactStartedAt, turn: undefined };
  if (flags.running) return { status: "working", since: flags.runStartedAt, turn: flags.turn };
  return { status: flags.outcome === "error" ? "error" : "ready", since: flags.idleSince, turn: undefined };
}

export type ModelInfo = Pick<SidebarSnapshot["session"], "model" | "provider" | "thinking">;

/** Model id, provider, and the thinking level for models that reason. */
export function readModel(model: ExtensionContext["model"], thinkingLevel: string | undefined): ModelInfo {
  if (!model) return { model: undefined, provider: undefined, thinking: undefined };
  const level = THINKING_LEVELS.find((candidate) => candidate === thinkingLevel);
  return {
    model: cleanText(String(model.id), 80),
    provider: cleanText(String(model.provider), 40),
    thinking: model.reasoning ? (level as ThinkingLevel | undefined) : undefined,
  };
}

/** D-6: OAuth (a subscription) or an API key (metered). */
export function readBilling(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, model = ctx.model): Billing | undefined {
  if (!model) return undefined;
  return ctx.modelRegistry.isUsingOAuth(model) ? "subscription" : "metered";
}

export function sessionName(name: string | undefined): string | undefined {
  const clean = name === undefined ? "" : cleanText(name, 120);
  return clean === "" ? undefined : clean;
}

/** Time of the newest entry, so a resumed session shows how long it has been idle. */
export function lastActivity(entries: readonly unknown[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isRecord(entry) && typeof entry.timestamp === "string") {
      const time = Date.parse(entry.timestamp);
      if (Number.isFinite(time)) return time;
    }
  }
  return undefined;
}
