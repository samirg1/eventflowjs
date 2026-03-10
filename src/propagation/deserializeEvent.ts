import { decryptContextFromPropagation } from "./encryptedContext.js";
import type { EventContext, SerializedPropagationEvent, Step } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toContext(value: unknown): EventContext {
  return isRecord(value) ? (value as EventContext) : {};
}

function toSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => {
      const name = typeof entry.name === "string" ? entry.name : "step";
      const t = typeof entry.t === "number" ? entry.t : 0;
      return { name, t };
    });
}

export function deserializeEvent(
  data: string,
  options?: { encryptionKey?: string },
): SerializedPropagationEvent | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const id = typeof parsed.id === "string" ? parsed.id : null;
  const name = typeof parsed.name === "string" ? parsed.name : null;
  const traceId = typeof parsed.traceId === "string" ? parsed.traceId : null;
  const timestamp =
    typeof parsed.timestamp === "string"
      ? parsed.timestamp
      : new Date().toISOString();

  if (!id || !name || !traceId) {
    return null;
  }

  return {
    id,
    name,
    timestamp,
    traceId,
    parentId:
      typeof parsed.parentId === "string" ? parsed.parentId : undefined,
    context: toContext(parsed.context),
    encryptedContext: decryptContextFromPropagation(
      parsed.encryptedContext,
      options?.encryptionKey,
    ),
    steps: toSteps(parsed.steps),
  };
}
