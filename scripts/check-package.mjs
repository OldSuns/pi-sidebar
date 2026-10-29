// node scripts/check-package.mjs: what `npm pack` would publish, and the manifest rules (design §4.1).
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const problems = [];
const expect = (ok, message) => {
  if (!ok) problems.push(message);
};

// PKG-1..PKG-4: the manifest.
expect(manifest.name === "@oldsuns/pi-sidebar", `name is ${manifest.name}, expected @oldsuns/pi-sidebar`);
expect(manifest.type === "module", 'type must be "module"');
expect(Array.isArray(manifest.keywords) && manifest.keywords.includes("pi-package"), 'keywords must include "pi-package"');
expect(Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0, "pi.extensions must list the entry point");
for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
  expect(manifest.peerDependencies?.[host] === "*", `peerDependencies.${host} must be "*" (PKG-2)`);
  expect(manifest.dependencies?.[host] === undefined, `${host} must not be a dependency (PKG-2)`);
}
expect(Object.keys(manifest.dependencies ?? {}).length === 0, "no runtime dependencies (PKG-4)");
const version = /VERSION = "([^"]+)"/.exec(readFileSync(join(root, "src", "version.ts"), "utf8"))?.[1];
expect(version === manifest.version, `src/version.ts says ${version}, package.json says ${manifest.version}`);

// What would be published.
// One command string: npm is a .cmd script on Windows and needs a shell there.
const pack = spawnSync("npm pack --dry-run --json --ignore-scripts", { cwd: root, encoding: "utf8", shell: true });
if (pack.status !== 0) {
  console.error(`check-package: npm pack failed\n${pack.stderr}`);
  process.exit(1);
}
// npm 10 prints a list, npm 12 an object keyed by package name.
const packed = JSON.parse(pack.stdout);
const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
const published = new Set((entry?.files ?? []).map((file) => file.path.replaceAll("\\", "/")));
const sources = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : [relative(root, join(dir, entry.name)).replaceAll("\\", "/")],
  );
for (const file of ["package.json", "README.md", ...sources(join(root, "src"))]) expect(published.has(file), `${file} is not published`);
for (const entry of manifest.pi?.extensions ?? []) expect(published.has(entry.replace(/^\.\//, "")), `extension entry ${entry} is not published`);
for (const file of published) {
  expect(!/^(test|docs|scripts|\.github|\.cache|\.ci)\//.test(file), `${file} should not be published`);
}

if (problems.length > 0) {
  console.error(`check-package: ${problems.length} problem(s)\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-package: ${published.size} files, manifest ok (${manifest.name}@${manifest.version})`);
