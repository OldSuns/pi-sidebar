import { cleanText, isRecord } from "../util.ts";
import type { ToolsInfo } from "./snapshot.ts";

/**
 * Tools declared to the model (`pi.getActiveTools()`) against all tools that are not hidden
 * (`pi.getAllTools()`), grouped by where they come from.
 */
export function readTools(active: readonly string[], all: readonly unknown[]): ToolsInfo {
  const info: ToolsInfo = { active: [], total: 0, builtin: 0, mcp: 0, extension: 0 };
  const seen = new Set<string>();
  for (const name of active) {
    const clean = cleanText(String(name), 60);
    if (clean !== "" && !seen.has(clean)) {
      seen.add(clean);
      info.active.push(clean);
    }
  }
  for (const tool of all) {
    if (!isRecord(tool) || tool.exposure === "hidden") continue;
    info.total++;
    const namespace = isRecord(tool.namespace) && typeof tool.namespace.name === "string" ? tool.namespace.name : "";
    const path = isRecord(tool.sourceInfo) && typeof tool.sourceInfo.path === "string" ? tool.sourceInfo.path : "";
    if (namespace.startsWith("mcp__") || path === "builtin:mcp") info.mcp++;
    else if (path.startsWith("builtin:")) info.builtin++;
    else info.extension++;
  }
  return info;
}
