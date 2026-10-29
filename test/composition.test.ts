import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  compositionFromRequest,
  compositionFromSession,
  contentText,
  type EstimateMessage,
  estimateText,
  fallbackEstimate,
  messageTokens,
  partCells,
  toolTokens,
} from "../src/state/composition.ts";

/** Pi's own estimator, as index.ts injects it: the parts must agree with how Pi counts a context. */
const estimate: EstimateMessage = (message) => estimateTokens(message as Parameters<typeof estimateTokens>[0]);

const USER = { role: "user", content: "a".repeat(40), timestamp: 0 };
const ASSISTANT = {
  role: "assistant",
  content: [
    { type: "text", text: "b".repeat(20) },
    { type: "toolCall", id: "1", name: "read", arguments: { path: "x" } },
  ],
};
const RESULT = {
  role: "toolResult",
  content: [
    { type: "text", text: "c".repeat(400) },
    { type: "image", data: "...", mimeType: "image/png" },
  ],
};
const SUMMARY = { role: "compactionSummary", summary: "d".repeat(80) };
const BASH = { role: "bashExecution", command: "ls", output: "e".repeat(38) };
const CUSTOM = { role: "custom", content: "f".repeat(8) };

test("breakdown: Pi's estimate of each message, in its part; excluded bash output and system messages are skipped", () => {
  const messages = [
    USER,
    ASSISTANT,
    RESULT,
    SUMMARY,
    { ...BASH, output: "e".repeat(4000), excludeFromContext: true },
    BASH,
    CUSTOM,
    { role: "system", content: "counted by the request path only" },
  ];
  const composition = compositionFromSession(messages, 100, 50, estimate);
  assert.deepEqual(composition.parts, {
    system: 100,
    tools: 50,
    messages: estimate(USER) + estimate(ASSISTANT),
    toolResults: estimate(RESULT),
    summary: estimate(SUMMARY),
    other: estimate(BASH) + estimate(CUSTOM),
  });
  // Pi counts an image as 4800 characters.
  assert.equal(composition.parts.toolResults, 1_300);
  assert.equal(composition.images, 1);
  assert.equal(composition.source, "session");
  assert.equal(composition.total, 100 + 50 + estimate(USER) + estimate(ASSISTANT) + 1_300 + 20 + estimate(BASH) + estimate(CUSTOM));
});

test("breakdown: a request transcript splits the system message into the prompt and the tool declarations", () => {
  const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
  const system = { role: "system", content: "p".repeat(400), sections: { rules: "r".repeat(40), gone: null }, toolsAdded: [tool] };
  const composition = compositionFromRequest([system, { role: "user", content: "u".repeat(4) }], estimate);
  assert.equal(composition.parts.system, 110);
  assert.equal(composition.parts.tools, estimateText(JSON.stringify([tool])));
  assert.equal(composition.parts.tools, toolTokens([tool]));
  // Together they are Pi's estimate of the whole system message, give or take the rounding of each.
  assert.ok(Math.abs((composition.parts.system ?? 0) + (composition.parts.tools ?? 0) - estimate(system)) <= 1);
  assert.equal(composition.parts.messages, 1);
  assert.equal(composition.source, "request");
});

test("breakdown: roles Pi does not know and messages it cannot read fall back to the same rule", () => {
  const foreign = { role: "extension-thing", content: [{ type: "text", text: "x".repeat(8) }, { type: "image" }] };
  assert.equal(estimate(foreign), 0);
  assert.equal(messageTokens(foreign, estimate), 1_202);
  // A tool call still streaming its arguments makes Pi's estimate throw.
  const streaming = { role: "assistant", content: [{ type: "toolCall", name: "read" }] };
  assert.throws(() => estimate(streaming));
  assert.equal(messageTokens(streaming, estimate), estimateText("read{}"));
  assert.equal(messageTokens(USER, () => Number.NaN), fallbackEstimate(USER));
  assert.equal(contentText([{ type: "thinking", thinking: "hm" }, { type: "image" }, "junk"]), "hm");
  assert.equal(fallbackEstimate("not a message"), 0);
  assert.equal(toolTokens([{ description: "no name" }]), undefined);
  assert.equal(toolTokens([]), 0);
});

test("breakdown bar: cells follow the shares, fill the width, and keep small parts visible", () => {
  const cells = partCells({ system: 10, tools: 30, messages: 59, toolResults: 0, summary: undefined, other: 1 }, 20);
  assert.equal(Object.values(cells).reduce((sum, count) => sum + count, 0), 20);
  assert.equal(cells.toolResults, 0);
  assert.equal(cells.other, 1);
  assert.ok(cells.messages >= 11);
  assert.equal(Object.values(partCells({ system: 0, tools: 0, messages: 0, toolResults: 0, summary: 0, other: 0 }, 20)).reduce((a, b) => a + b, 0), 0);
});
