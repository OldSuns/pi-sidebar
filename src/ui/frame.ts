import { visibleWidth } from "@earendil-works/pi-tui";
import type { Glyphs } from "./glyphs.ts";
import type { PanelRole, Role } from "./palette.ts";
import { type Action, type Row, row } from "./rows.ts";
import { fit, seg, truncatePlain } from "./text.ts";

/**
 * 36-column style: a rounded box in the panel colour with "✦ NAME" in the top border; content is
 * `width - 4`. Clicking the top border runs `titleAction` (folds the panel).
 */
export function box(role: PanelRole, title: string, rows: readonly Row[], width: number, g: Glyphs, titleAction?: Action): Row[] {
  const tint: Role = `tint:${role}`;
  const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = g.box;
  const head = truncatePlain(`${g.title} ${title}`, Math.max(1, width - 6), g.ellipsis);
  const dashes = Math.max(1, width - 5 - visibleWidth(head));
  const out: Row[] = [
    row([seg(`${topLeft}${horizontal} `, tint), seg(head, role, true), seg(` ${horizontal.repeat(dashes)}`, tint), seg(topRight, tint)], titleAction),
  ];
  for (const content of rows) {
    out.push(row([seg(`${vertical} `, tint), ...fit(content.segs, Math.max(1, width - 4), g.ellipsis), seg(` ${vertical}`, tint)], content.action));
  }
  out.push(row([seg(`${bottomLeft}${horizontal.repeat(Math.max(0, width - 2))}${bottomRight}`, tint)]));
  return out;
}

/** 28-column style: a "✦ NAME ───" rule in the panel colour and no box, so the content keeps every column. */
export function section(role: PanelRole, title: string, rows: readonly Row[], width: number, g: Glyphs, titleAction?: Action): Row[] {
  const head = truncatePlain(`${g.title} ${title}`, Math.max(1, width - 2), g.ellipsis);
  const rule = Math.max(0, width - visibleWidth(head) - 1);
  const out: Row[] = [row([seg(head, role, true), seg(` ${g.box.horizontal.repeat(rule)}`, `tint:${role}`)], titleAction)];
  for (const content of rows) out.push(row(fit(content.segs, width, g.ellipsis), content.action));
  return out;
}

/**
 * A folded panel: one line with its title and a short summary, e.g. "── ▸ GIT · main · 7 changed ───".
 * The boxed style starts with a short rule so it lines up with the open boxes.
 */
export function foldedLine(role: PanelRole, title: string, summary: string, width: number, g: Glyphs, boxed: boolean, action: Action): Row {
  const tint: Role = `tint:${role}`;
  const lead = boxed ? `${g.box.horizontal.repeat(2)} ` : "";
  const head = `${g.folded} ${title}`;
  const note = summary === "" ? "" : ` ${g.dot} ${summary}`;
  const room = Math.max(0, width - visibleWidth(lead) - visibleWidth(head) - 1);
  const shownNote = visibleWidth(note) <= room ? note : truncatePlain(note, room, g.ellipsis);
  const rule = Math.max(0, width - visibleWidth(lead) - visibleWidth(head) - visibleWidth(shownNote) - 1);
  const segs = [seg(lead, tint), seg(head, role, true), seg(shownNote, "faint"), seg(rule > 0 ? ` ${g.box.horizontal.repeat(rule)}` : "", tint)];
  return row(fit(segs, width, g.ellipsis), action);
}
