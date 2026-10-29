import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** NO_COLOR convention: any non-empty value turns colours off. */
export function noColorRequested(): boolean {
  return (process.env.NO_COLOR ?? "") !== "";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Text from outside (branch names, paths, tool arguments) on one line, without terminal sequences (SEC-2). */
export function cleanText(text: string, maxChars = 240): string {
  const flat = stripTerminalSequences(text).replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : flat;
}
