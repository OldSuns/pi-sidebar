import { homedir } from "node:os";
import { isRecord } from "../util.ts";
import type { StorageState } from "./snapshot.ts";

/** Paths under the home directory start with "~" (USERPROFILE on Windows, platform §E6). */
export function displayPath(path: string, home = homedir(), windows = process.platform === "win32"): string {
  const base = home.replace(/[\\/]+$/, "");
  if (base === "") return path;
  const fold = (text: string) => (windows ? text.replaceAll("/", "\\").toLowerCase() : text);
  const target = fold(path);
  if (target === fold(base)) return "~";
  return target.startsWith(fold(base) + (windows ? "\\" : "/")) ? `~${path.slice(base.length)}` : path;
}

export function shortSessionId(id: string | undefined): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}

/** D-7: Pi creates the session file once the session holds a user or assistant message. */
export function storageState(file: string | undefined, entries: readonly unknown[]): StorageState {
  if (!file) return "in-memory";
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role === "user" || entry.message.role === "assistant") return "saved";
  }
  return "new";
}

/** Branches of the session tree (`getTree()`): its leaves. */
export function countBranches(roots: readonly unknown[]): number {
  let leaves = 0;
  const pending: unknown[] = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isRecord(node)) continue;
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) leaves++;
    else pending.push(...children);
  }
  return leaves;
}
