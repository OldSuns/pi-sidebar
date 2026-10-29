import { isRecord } from "../util.ts";
import { type Composition, PART_NAMES, type PartName } from "./snapshot.ts";

/**
 * Estimated make-up of the context (design D-11): six parts, counted with Pi's own rule
 * (`estimateTokens` in compaction.js: characters / 4, 4800 characters per image), so the parts agree
 * with how Pi itself estimates a context. It is not the provider's tokenizer: the sidebar shows the
 * parts with "~" next to Pi's real context figure.
 */
export const estimateText = (text: string): number => Math.ceil(text.length / 4);

/** Pi's per-message estimate (`estimateTokens` from the SDK), injected so this module runs without the host. */
export type EstimateMessage = (message: unknown) => number;

/** Characters Pi assumes for an image (compaction.js `ESTIMATED_IMAGE_CHARS`). */
const IMAGE_CHARS = 4800;

function partOf(role: unknown): PartName {
  if (role === "toolResult") return "toolResults";
  if (role === "compactionSummary" || role === "branchSummary") return "summary";
  if (role === "user" || role === "assistant") return "messages";
  return "other";
}

/** Text of content blocks: text, thinking, and tool calls as name plus arguments. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "thinking" && typeof block.thinking === "string") text += block.thinking;
    else if (block.type === "toolCall") text += `${typeof block.name === "string" ? block.name : ""}${safeJson(block.arguments ?? {})}`;
  }
  return text;
}

function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let images = 0;
  for (const block of content) if (isRecord(block) && block.type === "image") images++;
  return images;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** The same rule for roles Pi's estimator does not know (it returns 0 for them), e.g. an extension's own. */
export function fallbackEstimate(message: unknown): number {
  if (!isRecord(message)) return 0;
  return Math.ceil((contentText(message.content).length + countImages(message.content) * IMAGE_CHARS) / 4);
}

/**
 * Pi's estimate of one message; the fallback when it knows nothing of the message or cannot read it
 * (it throws on a streaming tool call without arguments, for one).
 */
export function messageTokens(message: unknown, estimate: EstimateMessage): number {
  let tokens = 0;
  try {
    tokens = estimate(message);
  } catch {
    tokens = 0;
  }
  return Number.isFinite(tokens) && tokens > 0 ? tokens : fallbackEstimate(message);
}

/** Tool declarations as the model receives them: name, description and parameter schema. */
export function toolTokens(tools: readonly unknown[]): number | undefined {
  // No tools, no declarations in the request.
  if (tools.length === 0) return 0;
  const declarations: unknown[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") return undefined;
    declarations.push({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} });
  }
  const json = safeJson(declarations);
  return json === "" ? undefined : estimateText(json);
}

interface Estimate {
  system?: number;
  tools?: number;
  messages: readonly unknown[];
  estimate: EstimateMessage;
  source: Composition["source"];
}

function compose({ system, tools, messages, estimate, source }: Estimate): Composition {
  const parts: Record<PartName, number | undefined> = { system, tools, messages: 0, toolResults: 0, summary: 0, other: 0 };
  let images = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.role === "system") continue;
    // `!!command` output stays out of the context.
    if (message.role === "bashExecution" && message.excludeFromContext === true) continue;
    const part = partOf(message.role);
    parts[part] = (parts[part] ?? 0) + messageTokens(message, estimate);
    images += countImages(message.content);
  }
  const total = PART_NAMES.reduce((sum, name) => sum + (parts[name] ?? 0), 0);
  return { parts, total, images, source };
}

/**
 * From the transcript of a model request (`context_with_system`): system messages carry the prompt,
 * its named sections and the tool declarations (`toolsAdded`), counted as Pi counts them.
 */
export function compositionFromRequest(messages: readonly unknown[], estimate: EstimateMessage): Composition {
  let system = 0;
  let tools = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "system") continue;
    let text = contentText(message.content);
    if (isRecord(message.sections)) {
      for (const section of Object.values(message.sections)) if (typeof section === "string") text += section;
    }
    system += estimateText(text);
    if (Array.isArray(message.toolsAdded) && message.toolsAdded.length > 0) tools += estimateText(safeJson(message.toolsAdded));
  }
  return compose({ system, tools, messages, estimate, source: "request" });
}

/**
 * From the session between requests: the active branch, plus the system prompt and tool declarations
 * of the latest request when there was one, else Pi's current prompt and active tool schemas.
 */
export function compositionFromSession(
  messages: readonly unknown[],
  system: number | undefined,
  tools: number | undefined,
  estimate: EstimateMessage,
): Composition {
  return compose({ system, tools, messages, estimate, source: "session" });
}

/** Cells per part for a bar `width` wide (largest remainder), so the parts fill it exactly. */
export function partCells(parts: Record<PartName, number | undefined>, width: number): Record<PartName, number> {
  const cells = Object.fromEntries(PART_NAMES.map((name) => [name, 0])) as Record<PartName, number>;
  const present = PART_NAMES.filter((name) => (parts[name] ?? 0) > 0);
  const total = present.reduce((sum, name) => sum + (parts[name] ?? 0), 0);
  if (total === 0 || width <= 0) return cells;
  const exact = present.map((name) => ({ name, value: ((parts[name] ?? 0) / total) * width }));
  let used = 0;
  for (const { name, value } of exact) {
    cells[name] = Math.floor(value);
    used += cells[name];
  }
  for (const { name } of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1)).slice(0, width - used)) cells[name]++;
  // Every present part stays visible, borrowing a cell from the largest one.
  for (const name of present) {
    if (cells[name] > 0) continue;
    const largest = present.reduce((best, candidate) => (cells[candidate] > cells[best] ? candidate : best), present[0] as PartName);
    if (cells[largest] > 1) {
      cells[largest]--;
      cells[name] = 1;
    }
  }
  return cells;
}
