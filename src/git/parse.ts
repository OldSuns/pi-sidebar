import type { GitFile, GitFileStatus, GitInfo } from "../state/snapshot.ts";
import { cleanText } from "../util.ts";

export interface StatusResult {
  /** True before the first commit (`branch.oid (initial)`). */
  initial: boolean;
  commit?: string;
  /** Undefined for a detached HEAD. */
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: { status: GitFileStatus; path: string }[];
}

export interface LineCounts {
  added: number;
  removed: number;
  binary: boolean;
}

/** Parse `git status --porcelain=v2 -z --branch`. Paths are relative to the repository root. */
export function parseStatus(output: string): StatusResult {
  const result: StatusResult = { initial: false, ahead: 0, behind: 0, files: [] };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record === "") continue;
    if (record.startsWith("# ")) {
      readHeader(record.slice(2), result);
      continue;
    }
    const fields = record.split(" ");
    switch (fields[0]) {
      case "1":
        result.files.push({ status: ordinaryStatus(fields[1] ?? ""), path: fields.slice(8).join(" ") });
        break;
      case "2":
        // "R100" or "C75"; the original path follows as a record of its own.
        result.files.push({ status: (fields[8] ?? "").startsWith("C") ? "A" : "R", path: fields.slice(9).join(" ") });
        index++;
        break;
      case "u":
        result.files.push({ status: "U", path: fields.slice(10).join(" ") });
        break;
      case "?":
        result.files.push({ status: "?", path: record.slice(2) });
        break;
      default:
        break;
    }
  }
  return result;
}

function readHeader(header: string, result: StatusResult): void {
  const space = header.indexOf(" ");
  const key = space < 0 ? header : header.slice(0, space);
  const value = space < 0 ? "" : header.slice(space + 1);
  if (key === "branch.oid") {
    result.initial = value === "(initial)";
    result.commit = result.initial ? undefined : value.slice(0, 7);
  } else if (key === "branch.head") {
    result.branch = value === "(detached)" ? undefined : value;
  } else if (key === "branch.upstream") {
    result.upstream = value;
  } else if (key === "branch.ab") {
    const match = /^\+(\d+) -(\d+)$/.exec(value);
    if (match) {
      result.ahead = Number(match[1]);
      result.behind = Number(match[2]);
    }
  }
}

function ordinaryStatus(xy: string): GitFileStatus {
  const [staged, unstaged] = [xy[0], xy[1]];
  if (staged === "D" || unstaged === "D") return "D";
  return staged === "A" ? "A" : "M";
}

/** Parse `git diff --numstat -z`. Renames are keyed by their new path; binary files count no lines. */
export function parseNumstat(output: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(records[index] ?? "");
    if (!match) continue;
    let path = match[3] ?? "";
    if (path === "") {
      // A rename: the old path, then the new path.
      path = records[index + 2] ?? "";
      index += 2;
    }
    const binary = match[1] === "-" || match[2] === "-";
    counts.set(path, { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary });
  }
  return counts;
}

export function mergeCounts(...maps: Map<string, LineCounts>[]): Map<string, LineCounts> {
  const merged = new Map<string, LineCounts>();
  for (const map of maps) {
    for (const [path, counts] of map) {
      const previous = merged.get(path);
      merged.set(
        path,
        previous
          ? { added: previous.added + counts.added, removed: previous.removed + counts.removed, binary: previous.binary || counts.binary }
          : { ...counts },
      );
    }
  }
  return merged;
}

/** Changed files with their line counts: conflicts first, untracked last, the rest by changed lines (D-10). */
export function buildGitInfo(status: StatusResult, counts: Map<string, LineCounts>): GitInfo {
  const files = status.files.map(({ status: fileStatus, path }) => {
    const file: GitFile = { status: fileStatus, path: cleanText(path, 400) };
    const lines = fileStatus === "?" ? undefined : counts.get(path);
    if (lines?.binary) file.binary = true;
    else if (lines) {
      file.added = lines.added;
      file.removed = lines.removed;
    }
    return file;
  });
  files.sort((a, b) => rank(a) - rank(b) || churn(b) - churn(a));
  let added = 0;
  let removed = 0;
  for (const lines of counts.values()) {
    added += lines.added;
    removed += lines.removed;
  }
  return {
    branch: status.branch === undefined ? undefined : cleanText(status.branch, 200),
    commit: status.commit,
    upstream: status.upstream === undefined ? undefined : cleanText(status.upstream, 200),
    ahead: status.ahead,
    behind: status.behind,
    files,
    added,
    removed,
  };
}

const rank = (file: GitFile): number => (file.status === "U" ? 0 : file.status === "?" ? 2 : 1);
const churn = (file: GitFile): number => (file.added ?? 0) + (file.removed ?? 0);
