import assert from "node:assert/strict";
import { test } from "node:test";
import { pickWidth, type SidebarWidth } from "../src/layout/width.ts";

function walk(columns: number[], start: 0 | SidebarWidth): Record<number, number> {
  let width = start;
  const seen: Record<number, number> = {};
  for (const cols of columns) {
    width = pickWidth(cols, width, "auto", 64);
    seen[cols] = width;
  }
  return seen;
}

test("auto picks 36, then 28, then hides as the terminal narrows", () => {
  assert.deepEqual(walk([200, 146, 145, 99, 95, 92, 91, 80], 36), { 200: 36, 146: 36, 145: 28, 99: 28, 95: 28, 92: 28, 91: 0, 80: 0 });
});

test("each step up needs 4 more columns (hysteresis)", () => {
  assert.deepEqual(walk([80, 92, 95, 96, 146, 149, 150], 0), { 80: 0, 92: 0, 95: 0, 96: 28, 146: 28, 149: 28, 150: 36 });
});

test("a hidden sidebar comes back at 36 when the terminal jumps wide", () => {
  assert.equal(pickWidth(150, 0, "auto", 64), 36);
  assert.equal(pickWidth(149, 0, "auto", 64), 28);
});

test("a fixed width shows or hides only that width", () => {
  assert.equal(pickWidth(120, 0, 28, 64), 28);
  assert.equal(pickWidth(91, 28, 28, 64), 0);
  assert.equal(pickWidth(95, 0, 28, 64), 0);
  assert.equal(pickWidth(96, 0, 28, 64), 28);
  assert.equal(pickWidth(99, 36, 36, 64), 0);
  assert.equal(pickWidth(103, 0, 36, 64), 0);
  assert.equal(pickWidth(104, 0, 36, 64), 36);
});

test("min-main moves every threshold", () => {
  assert.equal(pickWidth(181, 36, "auto", 150), 28);
  assert.equal(pickWidth(181, 28, "auto", 160), 0);
  assert.equal(pickWidth(181, 0, "auto", 64), 36);
});

test("the result is a fixpoint, so asking twice in one frame agrees", () => {
  for (let cols = 60; cols <= 160; cols++) {
    for (const current of [0, 28, 36] as const) {
      for (const setting of ["auto", 28, 36] as const) {
        const once = pickWidth(cols, current, setting, 64);
        assert.equal(pickWidth(cols, once, setting, 64), once, `cols ${cols}, current ${current}, setting ${setting}`);
      }
    }
  }
});
