// npm run typecheck: type-check src/, test/ and scripts/ against the installed Pi's own declarations.
// Writes .cache/tsconfig.pi.json, which maps @earendil-works/* to that installation, then runs tsc:
// the TypeScript next to those packages when there is one (CI installs it there), else tsc on PATH.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piNodeModules } from "./pi-root.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = piNodeModules().replaceAll("\\", "/");
const pkg = (name) => `${modules}/@earendil-works/${name}`;
const config = {
  extends: "../tsconfig.json",
  compilerOptions: {
    typeRoots: [`${modules}/@types`],
    paths: {
      "@earendil-works/pi-coding-agent": [pkg("pi-coding-agent")],
      // scripts/screenshot.ts scripts a model with pi-ai's faux provider.
      "@earendil-works/pi-ai": [pkg("pi-ai")],
      "@earendil-works/pi-tui": [pkg("pi-tui")],
      "@earendil-works/pi-tui/*": [`${pkg("pi-tui")}/*`],
    },
  },
  include: ["../src/**/*.ts", "../test/**/*.ts", "../scripts/**/*.ts"],
};
const dir = join(root, ".cache");
mkdirSync(dir, { recursive: true });
const file = join(dir, "tsconfig.pi.json");
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

const localTsc = join(modules, "typescript", "bin", "tsc");
const result = existsSync(localTsc)
  ? spawnSync(process.execPath, [localTsc, "-p", file], { stdio: "inherit" })
  : // One command string: tsc may be a .cmd script, which needs a shell on Windows.
    spawnSync(`tsc -p "${file}"`, { stdio: "inherit", shell: true });
if (result.error) console.error(`typecheck: could not run tsc (${result.error.message}); install TypeScript or put tsc on PATH`);
process.exit(result.status ?? 1);
