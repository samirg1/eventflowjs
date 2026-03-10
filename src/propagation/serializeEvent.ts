import { encryptContextForPropagation } from "./encryptedContext.js";
import type { EventLog, SerializedPropagationEvent } from "../types.js";

export function serializeEvent(
  event: EventLog,
  options?: { encryptionKey?: string },
): string {
  const payload: SerializedPropagationEvent = {
    id: event.id,
    name: event.name,
    timestamp: event.timestamp,
    traceId: event.traceId,
    parentId: event.parentId,
    context: event.context,
    encryptedContext: encryptContextForPropagation(
      event.encryptedContext,
      options?.encryptionKey,
    ),
    steps: event.steps,
  };

  return JSON.stringify(payload);
}
