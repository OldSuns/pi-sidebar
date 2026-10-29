import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-index-"));
// Keep the real settings file out of reach.
process.env.PI_SIDEBAR_CONFIG = join(dir, "pi-sidebar.json");
after(() => rmSync(dir, { recursive: true, force: true }));

const EVENTS = [
  "session_start",
  "session_shutdown",
  "session_info_changed",
  "session_tree",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "input",
  "agent_start",
  "turn_start",
  "context_with_system",
  "before_provider_request",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_before_settle",
  "agent_settled",
  "model_select",
  "thinking_level_select",
  "mcp_servers_change",
  "user_bash",
];

test("the extension registers its handlers and /sidebar, and no handler returns a result for Pi to act on", async () => {
  const { default: piSidebar } = await import("../src/index.ts");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { description?: string; handler: unknown }>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      assert.ok(!handlers.has(event), `${event} registered twice`);
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { description?: string; handler: unknown }) => commands.set(name, options),
  };
  piSidebar(pi as unknown as ExtensionAPI);
  assert.deepEqual([...handlers.keys()].sort(), [...EVENTS].sort());
  assert.deepEqual([...commands.keys()], ["sidebar"]);
  assert.equal(typeof commands.get("sidebar")?.handler, "function");

  // A print-mode session: the sidebar stays off, and every handler returns nothing.
  const ctx = { mode: "print", cwd: dir, ui: { setWidget: () => assert.fail("no widget outside the TUI") } };
  const event = { message: { role: "assistant", content: [] }, messages: [], turnIndex: 0, toolCallId: "t", toolName: "bash", args: {}, aborted: false };
  for (const [name, handler] of handlers) assert.equal(handler(event, ctx), undefined, name);
});
