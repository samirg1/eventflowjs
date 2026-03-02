import type { EventLog, SerializedPropagationEvent } from "../types.js";

export function serializeEvent(event: EventLog): string {
  const payload: SerializedPropagationEvent = {
    id: event.id,
    name: event.name,
    timestamp: event.timestamp,
    traceId: event.traceId,
    parentId: event.parentId,
    context: event.context,
    steps: event.steps,
  };

  return JSON.stringify(payload);
}
