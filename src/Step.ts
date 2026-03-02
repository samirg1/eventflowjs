import type { Step } from "./types.js";

export function createStep(name: string, startTimeMs: number, nowMs = Date.now()): Step {
  return {
    name,
    t: Math.max(0, nowMs - startTimeMs),
  };
}
