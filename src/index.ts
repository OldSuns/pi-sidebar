import { join } from "node:path";
import { estimateTokens, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerSidebarCommand } from "./commands.ts";
import { SidebarController } from "./controller.ts";

/**
 * pi-sidebar: a session sidebar beside Pi's fullscreen layout (docs/design/pi-sidebar-design.md).
 * The factory only registers handlers (LIFE-1); everything starts at session_start. No handler
 * returns a result, so none of them changes what Pi does.
 */
export default function piSidebar(pi: ExtensionAPI): void {
  const sidebar = new SidebarController(pi, {
    // PI_SIDEBAR_CONFIG points the settings elsewhere, e.g. to keep test runs away from the real file.
    configFile: process.env.PI_SIDEBAR_CONFIG || join(getAgentDir(), "pi-sidebar.json"),
    estimateTokens: (message) => estimateTokens(message as Parameters<typeof estimateTokens>[0]),
  });

  pi.on("session_start", (_event, ctx) => sidebar.start(ctx));
  pi.on("session_shutdown", (_event, ctx) => sidebar.shutdown(ctx));
  pi.on("session_info_changed", (event) => sidebar.onSessionInfo(event.name));
  pi.on("session_tree", (_event, ctx) => sidebar.onSessionTree(ctx));
  pi.on("session_before_compact", () => sidebar.onCompactStart());
  pi.on("session_compact", (_event, ctx) => sidebar.onCompactEnd(ctx));
  pi.on("session_compact_failed", (_event, ctx) => sidebar.onCompactEnd(ctx));

  pi.on("input", (event) => sidebar.onInput(event.streamingBehavior !== undefined));
  pi.on("agent_start", (_event, ctx) => sidebar.onAgentStart(ctx));
  pi.on("turn_start", (event, ctx) => sidebar.onTurnStart(event.turnIndex, ctx));
  pi.on("context_with_system", (event) => sidebar.onRequestContext(event.messages));
  pi.on("before_provider_request", () => sidebar.onProviderRequest());
  pi.on("message_update", (event) => sidebar.onMessageUpdate(event.message));
  pi.on("message_end", (event, ctx) => sidebar.onMessageEnd(event.message, ctx));
  pi.on("tool_execution_start", (event) => sidebar.onToolStart(event));
  pi.on("tool_execution_end", (event) => sidebar.onToolEnd(event));
  pi.on("turn_end", (_event, ctx) => sidebar.onTurnEnd(ctx));
  pi.on("agent_before_settle", (event) => sidebar.onBeforeSettle(event.outcome));
  pi.on("agent_settled", (event, ctx) => sidebar.onAgentSettled(event.aborted, ctx));

  pi.on("model_select", (event, ctx) => sidebar.onModelSelect(event.model, ctx));
  pi.on("thinking_level_select", (event, ctx) => sidebar.onThinkingSelect(event.level, ctx));
  pi.on("mcp_servers_change", () => sidebar.onToolsChanged());
  pi.on("user_bash", () => sidebar.onUserBash());

  registerSidebarCommand(pi, sidebar);
}
