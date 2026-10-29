// node scripts/check-rules.mjs: the main window stays Pi's own (design §4.0). Fails when src/ calls
// an API the design rules out, or reads Pi's private layout root outside the layout host (HOST-1).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Calls that would change the main window, the session or the terminal, with the rule they break. */
const FORBIDDEN = [
  [/\bsetEditorComponent\s*\(/, "MAIN-2: replaces the editor"],
  [/\bsetFooter\s*\(/, "MAIN-2: replaces the footer"],
  [/\bsetHeader\s*\(/, "MAIN-2: replaces the header"],
  [/\bsetWorking(Message|Indicator|Visible)\s*\(/, "MAIN-2: changes the working indicator"],
  [/\bsetHiddenThinkingLabel\s*\(/, "MAIN-2: changes the transcript"],
  [/\bsetToolsExpanded\s*\(/, "MAIN-2: changes the transcript"],
  [/\bsetTheme\s*\(/, "MAIN-2/MAIN-8: changes the theme"],
  [/\b(showOverlay|hideOverlay)\s*\(/, "MAIN-3: overlays cover the main window"],
  [/\bui\.(custom|select|confirm|input|editor)\s*\(/, "MAIN-3: dialogs take the editor's place"],
  [/\b(onTerminalInput|addInputListener)\s*\(/, "MAIN-3: input listeners see every key"],
  [/\bsetFocus\s*\(/, "MAIN-3: the sidebar never takes keyboard focus"],
  [/\bfocus\s*:\s*true\b/, "MAIN-3: the sidebar never takes keyboard focus"],
  [/\bhandleInput\s*\(/, "R-7: no keyboard handling in the sidebar"],
  [/\b(setStatus|setTitle)\s*\(/, "MAIN-4: draws in the main window"],
  [/\bregisterShortcut\s*\(/, "MAIN-5: no shortcuts"],
  [/\b(appendEntry|sendMessage|sendUserMessage|setSessionName|setLabel|setActiveTools|setModel|setThinkingLevel)\s*\(/, "MAIN-6: writes the session or changes the agent"],
  [/\bctx\.compact\s*\(/, "MAIN-6: compacts the session"],
  [/\b(newSession|fork|switchSession|navigateTree)\s*\(/, "MAIN-6: changes the session"],
  [/\b(stdout|terminal)\.write\s*\(/, "HOST-2: writes to the terminal behind Pi's back"],
  [/\.prototype\.\w+\s*=/, "HOST-2: patches a prototype"],
];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Comments may name the rules they keep; only code counts. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const problems = [];
let widgets = 0;
for (const path of files(join(root, "src"))) {
  const name = relative(root, path).replaceAll("\\", "/");
  const lines = code(readFileSync(path, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const [pattern, rule] of FORBIDDEN) {
      if (pattern.test(line)) problems.push(`${name}:${index + 1}: ${rule}\n    ${line.trim()}`);
    }
    if (/\blayoutRoot\b/.test(line) && name !== "src/host/layout-host.ts") {
      problems.push(`${name}:${index + 1}: HOST-1: Pi's private layout root is read only in src/host/layout-host.ts`);
    }
    if (/\bsetWidget\s*\(/.test(line)) {
      widgets++;
      // The key may sit on the next line of a wrapped call.
      if (!/PROBE_KEY/.test(lines.slice(index, index + 3).join(" "))) {
        problems.push(`${name}:${index + 1}: MAIN-4: the only widget is the zero-line probe (PROBE_KEY)`);
      }
    }
  });
}
if (widgets === 0) problems.push("src: the probe widget (setWidget with PROBE_KEY) is missing");

if (problems.length > 0) {
  console.error(`check-rules: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("check-rules: src/ keeps the main-window rules (design §4.0)");
