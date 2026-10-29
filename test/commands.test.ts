import assert from "node:assert/strict";
import { test } from "node:test";
import { type SidebarActions, completions, runSidebarCommand } from "../src/commands.ts";
import { defaultConfig } from "../src/config.ts";

function stubActions() {
  const calls: string[] = [];
  const record = (call: string) => {
    calls.push(call);
    return `done: ${call}`;
  };
  const actions: SidebarActions = {
    config: defaultConfig(),
    setEnabled: (enabled) => record(`enabled ${enabled}`),
    setWidth: (width) => record(`width ${width}`),
    setMinMainWidth: (columns) => record(`min-main ${columns}`),
    setPanel: (panel, on) => record(`panel ${panel} ${on}`),
    setFold: (panel, folded) => record(`fold ${panel} ${folded}`),
    setBreakdown: (on) => record(`breakdown ${on}`),
    setGitFiles: (count) => record(`git files ${count}`),
    setColors: (colors) => record(`colors ${colors}`),
    setIcons: (icons) => record(`icons ${icons}`),
    reset: () => record("reset"),
    statusText: () => record("status"),
    dumpScreen: () => record("dump"),
  };
  return { actions, calls };
}

test("every subcommand reaches its action", () => {
  const cases: [string, string][] = [
    ["", "enabled false"],
    ["toggle", "enabled false"],
    ["on", "enabled true"],
    [" OFF ", "enabled false"],
    ["status", "status"],
    ["width auto", "width auto"],
    ["width 28", "width 28"],
    ["width 36", "width 36"],
    ["min-main 48", "min-main 48"],
    ["min-main 160", "min-main 160"],
    ["panel usage off", "panel usage false"],
    ["panel  workspace   on", "panel workspace true"],
    ["panel tools off", "panel tools false"],
    ["fold git", "fold git true"],
    ["unfold session", "fold session false"],
    ["fold all", "fold all true"],
    ["unfold all", "fold all false"],
    ["breakdown off", "breakdown false"],
    ["breakdown on", "breakdown true"],
    ["git off", "panel git false"],
    ["git on", "panel git true"],
    ["git files 0", "git files 0"],
    ["git files 10", "git files 10"],
    ["colors vivid", "colors vivid"],
    ["icons ascii", "icons ascii"],
    ["reset", "reset"],
    ["dump", "dump"],
  ];
  for (const [args, call] of cases) {
    const { actions, calls } = stubActions();
    const result = runSidebarCommand(actions, args);
    assert.deepEqual(calls, [call], `/sidebar ${args}`);
    assert.equal(result.level, "info");
  }
});

test("invalid input changes nothing and shows the usage", () => {
  for (const args of [
    "width 40",
    "width",
    "min-main 20",
    "min-main 64.5",
    "panel session on",
    "panel git maybe",
    "fold everything",
    "unfold",
    "breakdown maybe",
    "git files 11",
    "git files",
    "colors neon",
    "icons emoji",
    "on now",
    "status please",
    "frobnicate",
  ]) {
    const { actions, calls } = stubActions();
    const result = runSidebarCommand(actions, args);
    assert.deepEqual(calls, [], `/sidebar ${args}`);
    assert.equal(result.level, "warning");
    assert.match(result.text, /Usage: \/sidebar/);
  }
});

test("errors from an action are reported, not thrown", () => {
  const { actions } = stubActions();
  actions.setWidth = () => {
    throw new Error("disk full");
  };
  assert.deepEqual(runSidebarCommand(actions, "width 28"), { text: "sidebar: disk full", level: "error" });
});

test("completions narrow by what was typed", () => {
  assert.deepEqual(completions("w")?.map((item) => item.value), ["width auto", "width 28", "width 36"]);
  assert.deepEqual(completions("panel  g")?.map((item) => item.value), ["panel git on", "panel git off"]);
  assert.deepEqual(completions("GIT F")?.map((item) => item.value), ["git files 3"]);
  assert.deepEqual(completions("unfold a")?.map((item) => item.value), ["unfold activity", "unfold all"]);
  assert.equal(completions("zzz"), null);
  assert.ok((completions("")?.length ?? 0) > 30);
});
