// node scripts/check-docs.mjs [file.md ...]: structure of the Markdown files (README.md and docs/
// by default): balanced code fences, table rows with the header's cell count, and relative links and
// images that exist.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function markdown(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? markdown(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((file) => resolve(file)) : [join(root, "README.md"), ...markdown(join(root, "docs"))];
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).length;
const problems = [];

for (const file of targets) {
  const name = relative(root, file).replaceAll("\\", "/");
  const lines = readFileSync(file, "utf8").split("\n");
  let fence = false;
  let fences = 0;
  let tableCells;
  let tableStart = 0;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      fences++;
      tableCells = undefined;
      return;
    }
    if (fence) return;
    if (/^\s*\|/.test(line)) {
      const count = cells(line);
      if (tableCells === undefined) {
        tableCells = count;
        tableStart = index + 1;
      } else if (count !== tableCells) {
        problems.push(`${name}:${index + 1}: table row has ${count} cells, header (line ${tableStart}) has ${tableCells}`);
      }
    } else {
      tableCells = undefined;
    }
    for (const match of line.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
      if (!existsSync(resolve(dirname(file), match[1]))) problems.push(`${name}:${index + 1}: broken link ${match[1]}`);
    }
  });
  if (fences % 2 !== 0) problems.push(`${name}: unbalanced code fences (${fences})`);
}

if (problems.length > 0) {
  console.error(`check-docs: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`check-docs: ${targets.length} file(s) ok`);
