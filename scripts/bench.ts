// Rough timings of the sidebar's hot paths on sample data (design PERF-1, PERF-3, PERF-6):
//   node --import ./test/support/register.mjs scripts/bench.ts
// Prints a Markdown table: the median and 95th percentile time of one operation.

import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { compositionFromSession, type EstimateMessage, messageTokens } from "../src/state/composition.ts";
import { scanUsage, startScan } from "../src/state/usage.ts";
import { Palette } from "../src/ui/palette.ts";
import { PanelsView, SidebarFrame, type SidebarModel } from "../src/ui/sidebar.ts";
import { fakeTheme, sampleSnapshot, testView } from "../test/helpers.ts";

interface Result {
  name: string;
  median: number;
  p95: number;
}

/** Times `samples` batches of `batch` calls; a batch smooths out the timer's resolution for fast calls. */
function measure(name: string, samples: number, batch: number, run: () => void): Result {
  for (let index = 0; index < Math.max(3, samples / 10) * batch; index++) run();
  const times: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let index = 0; index < batch; index++) run();
    times.push((performance.now() - start) / batch);
  }
  times.sort((a, b) => a - b);
  return { name, median: times[Math.floor(times.length / 2)] ?? 0, p95: times[Math.floor(times.length * 0.95)] ?? 0 };
}

const estimate: EstimateMessage = (message) => estimateTokens(message as Parameters<typeof estimateTokens>[0]);
const results: Result[] = [];

// ---- rendering (PERF-1, PERF-6) ----

let key = 0;
const palette = new Palette(fakeTheme(), "theme");
const view = testView();
const model: SidebarModel = {
  snapshot: sampleSnapshot(),
  view: () => view,
  palette: () => palette,
  rows: () => 56,
  renderKey: () => String(key),
  invalidate() {},
  reportError(_where, error) {
    throw error;
  },
  act() {},
};
const header = new PanelsView(model, "normal", "header", true);
const body = new PanelsView(model, "normal", "body", true);
results.push(measure("sidebar lines, nothing changed (cache hit)", 200, 1_000, () => [header.render(36), body.render(36)]));
results.push(
  measure("sidebar lines, snapshot changed (redraw)", 200, 20, () => {
    key++;
    header.render(36);
    body.render(36);
  }),
);

// A transcript-like main area: one styled run of text per line, as Pi draws most of a reply.
const prose = "The quick brown fox jumps over the lazy dog while the sidebar watches the context grow. ".repeat(3);
const mainArea = (columns: number): Component => {
  const lines = Array.from({ length: 56 }, () => `\u001b[38;2;205;214;244m${prose.slice(0, columns - 2)}\u001b[39m`);
  return { render: () => lines, invalidate() {} };
};
const pi = new VStack([mainArea(181)]);
results.push(measure("frame 181x56, Pi alone", 200, 20, () => renderLayoutFrame(pi, 181, 56, () => {})));
for (const [tier, width, columns] of [
  ["normal", 36, 181],
  ["compact", 28, 100],
] as const) {
  const root = new HStack([
    { component: new VStack([mainArea(columns - width)]), basis: 0, grow: 1, shrink: 1 },
    { component: new SidebarFrame(model, tier), basis: width, grow: 0, shrink: 0 },
  ]);
  results.push(measure(`frame ${columns}x56 with the ${width}-column sidebar`, 200, 5, () => renderLayoutFrame(root, columns, 56, () => {})));
}

// ---- usage totals (PERF-3) ----

const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, totalTokens: 470, cost: { total: 0.01 } };
const entries: unknown[] = Array.from({ length: 10_000 }, (_, index) =>
  index % 2 === 0 ? { type: "message", message: { role: "user", content: "next step" } } : { type: "message", message: { role: "assistant", usage } },
);
const scanned = scanUsage(entries, startScan());
const grown = [...entries, entries[1]];
results.push(measure("usage, full scan of 10,000 entries (session start)", 50, 1, () => scanUsage(entries, startScan())));
results.push(measure("usage, one new entry after 10,000 (each event)", 200, 50, () => scanUsage(grown, scanned)));

// ---- context breakdown and streaming speed ----

const text = (chars: number) => "lorem ipsum ".repeat(Math.ceil(chars / 12)).slice(0, chars);
const messages: unknown[] = [];
for (let index = 0; index < 700; index++) {
  messages.push({ role: "user", content: text(500) });
  messages.push({
    role: "assistant",
    content: [
      { type: "text", text: text(1_500) },
      { type: "toolCall", id: String(index), name: "read", arguments: { path: `src/file-${index}.ts` } },
    ],
  });
  messages.push({ role: "toolResult", content: [{ type: "text", text: text(4_000) }] });
}
results.push(measure("breakdown of 2,100 messages, 4.2 MB (turn end)", 30, 1, () => compositionFromSession(messages, 1_000, 2_000, estimate)));
const streaming = { role: "assistant", content: [{ type: "thinking", thinking: text(8_000) }, { type: "text", text: text(12_000) }] };
results.push(measure("estimate of a 20 KB streaming reply (at most every 150 ms)", 200, 20, () => messageTokens(streaming, estimate)));

const format = (ms: number) => (ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`);
console.log(`Node ${process.version} · ${process.platform} ${process.arch} · ${cpus()[0]?.model.trim() ?? "unknown CPU"}\n`);
console.log("| Operation | Median | p95 |");
console.log("| --- | --- | --- |");
for (const result of results) console.log(`| ${result.name} | ${format(result.median)} | ${format(result.p95)} |`);
