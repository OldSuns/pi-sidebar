// Locates the node_modules directory of the installed Pi, so type checks and tests use the host's own
// packages instead of a second copy from npm. PI_NODE_MODULES overrides the search.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piNodeModules() {
  if (process.env.PI_NODE_MODULES) return process.env.PI_NODE_MODULES;
  const releases = join(homedir(), ".pi", "agent", "install", "releases");
  const versions = existsSync(releases)
    ? readdirSync(releases).filter((name) => existsSync(join(releases, name, "node_modules", "@earendil-works", "pi-tui")))
    : [];
  if (versions.length === 0) {
    throw new Error("Pi installation not found: set PI_NODE_MODULES to the node_modules directory that holds @earendil-works/pi-tui");
  }
  versions.sort(compareVersions);
  return join(releases, versions[versions.length - 1], "node_modules");
}

function compareVersions(a, b) {
  const left = a.split(/[.-]/).map(Number);
  const right = b.split(/[.-]/).map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
