import type { CallerInfo } from "../types.js";

const SKIP_PATTERNS = [
  "EventFlow.",
  "new EventRecord",
  "EventRecord.",
  "getCallerInfo",
  "node:internal",
];

function parseLine(rawLine: string): CallerInfo | null {
  const line = rawLine.trim();
  const withFunction = /^at\s+(.*?)\s+\((.*):(\d+):(\d+)\)$/.exec(line);
  if (withFunction) {
    const [, fn, file, lineNo] = withFunction;
    return { file, line: Number(lineNo), function: fn };
  }

  const withoutFunction = /^at\s+(.*):(\d+):(\d+)$/.exec(line);
  if (withoutFunction) {
    const [, file, lineNo] = withoutFunction;
    return { file, line: Number(lineNo) };
  }

  return null;
}

export function getCallerInfo(): CallerInfo | undefined {
  const stack = new Error().stack;
  if (!stack) {
    return undefined;
  }

  const lines = stack.split("\n").slice(1);
  for (const rawLine of lines) {
    if (SKIP_PATTERNS.some((pattern) => rawLine.includes(pattern))) {
      continue;
    }

    const parsed = parseLine(rawLine);
    if (!parsed) {
      continue;
    }

    return parsed;
  }

  return undefined;
}
