import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changedSettings, configFileContent, defaultConfig, loadConfig, parseConfig, saveConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a missing file gives the defaults without warnings", () => {
  assert.deepEqual(loadConfig(join(dir, "missing.json")), { config: defaultConfig(), warnings: [] });
});

test("unknown keys are reported, bad values keep their defaults, numbers are clamped", () => {
  const { config, warnings } = parseConfig({
    width: 40,
    minMainWidth: 10,
    panels: { git: false, extra: true },
    folded: ["git", "bogus", "git", "session"],
    contextBreakdown: "yes",
    git: { maxFiles: 99, pollSeconds: 0 },
    colors: "neon",
    icons: "ascii",
    contextWarnPercent: 60,
    recentTools: -2,
    future: 1,
  });
  assert.equal(config.width, "auto");
  assert.equal(config.minMainWidth, 48);
  assert.deepEqual(config.panels, { usage: true, activity: true, git: false, tools: true, workspace: true });
  assert.deepEqual(config.folded, ["git", "session"]);
  assert.equal(config.contextBreakdown, true);
  assert.deepEqual(config.git, { maxFiles: 10, pollSeconds: 0 });
  assert.equal(config.colors, "theme");
  assert.equal(config.icons, "ascii");
  assert.equal(config.contextWarnPercent, 60);
  assert.equal(config.recentTools, 0);
  for (const expected of ['"future"', '"panels.extra"', "width must be", "colors must be", "minMainWidth 10 clamped to 48", '"bogus"', "contextBreakdown"]) {
    assert.ok(warnings.some((warning) => warning.includes(expected)), `missing warning: ${expected}`);
  }
});

test("poll seconds: 0 or less turns polling off, small values become 5", () => {
  assert.equal(parseConfig({ git: { pollSeconds: -1 } }).config.git.pollSeconds, 0);
  assert.equal(parseConfig({ git: { pollSeconds: 2 } }).config.git.pollSeconds, 5);
});

test("the file holds only changed settings and keeps keys it does not know", () => {
  const file = join(dir, "keep.json");
  writeFileSync(file, JSON.stringify({ future: { a: 1 }, panels: { extra: true }, width: 36 }));
  const config = defaultConfig();
  config.width = 28;
  config.panels.git = false;
  config.folded = ["usage"];
  saveConfig(config, file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    future: { a: 1 },
    width: 28,
    panels: { extra: true, git: false },
    folded: ["usage"],
  });
  const loaded = loadConfig(file);
  assert.equal(loaded.config.width, 28);
  assert.equal(loaded.config.panels.git, false);
  assert.deepEqual(loaded.config.folded, ["usage"]);
});

test("defaults write an empty object", () => {
  assert.deepEqual(configFileContent(defaultConfig(), {}), {});
});

test("a file that is not valid JSON is never overwritten", () => {
  const file = join(dir, "broken.json");
  writeFileSync(file, "{ broken");
  assert.throws(() => saveConfig(defaultConfig(), file), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "{ broken");
  const loaded = loadConfig(file);
  assert.deepEqual(loaded.config, defaultConfig());
  assert.match(loaded.warnings[0] ?? "", /not valid JSON/);
});

test("changed settings are listed with dotted names", () => {
  const config = defaultConfig();
  config.width = 36;
  config.panels.git = false;
  config.folded = ["git"];
  config.contextBreakdown = false;
  config.git.maxFiles = 5;
  assert.deepEqual(changedSettings(config), ["width", "panels.git", "folded", "contextBreakdown", "git.maxFiles"]);
});
