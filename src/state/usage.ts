import { isRecord } from "../util.ts";
import type { UsageTotals } from "./snapshot.ts";

export interface UsageScan {
  readonly totals: UsageTotals;
  /** Entries already counted. */
  readonly scanned: number;
}

export function startScan(): UsageScan {
  return { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, scanned: 0 };
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function add(totals: UsageTotals, usage: unknown): void {
  if (!isRecord(usage)) return;
  totals.input += count(usage.input);
  totals.output += count(usage.output);
  totals.cacheRead += count(usage.cacheRead);
  totals.cacheWrite += count(usage.cacheWrite);
  if (isRecord(usage.cost)) totals.cost += count(usage.cost.total);
}

/**
 * Session totals counted like Pi's footer (D-3..D-5, `footer.js` and `usage-totals.js`): every entry of the
 * session file, adding usage entries, assistant messages, and tool results and summaries that carry usage.
 * `output` already includes reasoning tokens (D-4). The hit rate is that of the latest assistant message.
 * Only entries after `scan.scanned` are read: the entry list is append-only, and a shorter list starts over.
 */
export function scanUsage(entries: readonly unknown[], scan: UsageScan): UsageScan {
  const restart = entries.length < scan.scanned;
  const totals: UsageTotals = restart ? startScan().totals : { ...scan.totals };
  for (let index = restart ? 0 : scan.scanned; index < entries.length; index++) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    if (entry.type === "usage") {
      add(totals, entry.usage);
    } else if (entry.type === "message" && isRecord(entry.message)) {
      const { role, usage } = entry.message;
      if (role === "assistant" && isRecord(usage)) {
        add(totals, usage);
        const prompt = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
        totals.hitRate = prompt > 0 ? (count(usage.cacheRead) / prompt) * 100 : undefined;
      } else if (role === "toolResult") {
        add(totals, usage);
      }
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      add(totals, entry.usage);
    }
  }
  return { totals, scanned: entries.length };
}
