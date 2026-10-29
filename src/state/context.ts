import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SidebarSnapshot } from "./snapshot.ts";

export type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

/** Pi's own defaults (settings-defaults.js): auto-compaction on, 16384 tokens reserved. */
const DEFAULT_COMPACTION_ENABLED = true;
const DEFAULT_RESERVE_TOKENS = 16_384;

/** CONTEXT panel data (D-1) with the auto-compact threshold Pi applies itself (D-2). */
export function readContext(ctx: ExtensionContext, settings: PiSettings, model = ctx.model): SidebarSnapshot["context"] {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  return {
    tokens: usage.tokens,
    window: usage.contextWindow,
    percent: usage.percent,
    compactAt: compactionThreshold(settings, model, usage.contextWindow),
  };
}

/**
 * Same rule as Pi's auto-compaction (agent-session.js `_checkCompaction`, compaction.js `shouldCompact`):
 * none while `compaction.enabled` is false, otherwise the window minus `reserveTokens`, where a
 * `compaction.modelOverrides["provider/modelId"]` value beats `compaction.reserveTokens`.
 */
export function compactionThreshold(settings: PiSettings, model: ExtensionContext["model"], window: number): number | undefined {
  const compaction = settings.compaction;
  if (!(compaction?.enabled ?? DEFAULT_COMPACTION_ENABLED)) return undefined;
  const override = model ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens : undefined;
  const threshold = window - (override ?? compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
  return threshold > 0 ? threshold : undefined;
}
