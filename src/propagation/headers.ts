import { deserializeEvent } from "./deserializeEvent.js";
import { serializeEvent } from "./serializeEvent.js";
import type {
  EventContext,
  EventLog,
  HeaderValue,
  HeadersLike,
  SerializedPropagationEvent,
} from "../types.js";

export const TRACE_ID_HEADER = "x-eventflow-trace-id";
export const EVENT_ID_HEADER = "x-eventflow-event-id";
export const CONTEXT_HEADER = "x-eventflow-context";
export const EVENT_HEADER = "x-eventflow-event";

export function getPropagationHeaders(event: EventLog): Record<string, string> {
  return {
    [TRACE_ID_HEADER]: event.traceId,
    [EVENT_ID_HEADER]: event.id,
    [CONTEXT_HEADER]: JSON.stringify(event.context),
    [EVENT_HEADER]: serializeEvent(event),
  };
}

export function extractEventFromHeaders(
  headers: HeadersLike,
): SerializedPropagationEvent | null {
  const traceId = getHeader(headers, TRACE_ID_HEADER);
  const eventId = getHeader(headers, EVENT_ID_HEADER);
  const contextRaw = getHeader(headers, CONTEXT_HEADER);
  const eventRaw = getHeader(headers, EVENT_HEADER);

  const parsedContext = parseContext(contextRaw);
  const parsedEvent = eventRaw ? deserializeEvent(eventRaw) : null;

  if (parsedEvent) {
    return {
      ...parsedEvent,
      id: eventId ?? parsedEvent.id,
      traceId: traceId ?? parsedEvent.traceId,
      context: {
        ...parsedEvent.context,
        ...parsedContext,
      },
    };
  }

  if (!eventId || !traceId) {
    return null;
  }

  return {
    id: eventId,
    name: "propagated-event",
    traceId,
    timestamp: new Date().toISOString(),
    context: parsedContext,
    steps: [],
  };
}

function parseContext(raw: string | undefined): EventContext {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as EventContext;
    }
  } catch {
    return {};
  }

  return {};
}

function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (hasHeaderGetter(headers)) {
    return normalizeHeaderValue(headers.get(name) ?? headers.get(name.toLowerCase()));
  }

  const asRecord = headers as Record<string, HeaderValue>;
  return normalizeHeaderValue(asRecord[name] ?? asRecord[name.toLowerCase()]);
}

function hasHeaderGetter(
  headers: HeadersLike,
): headers is { get(name: string): string | null | undefined } {
  return typeof (headers as { get?: unknown }).get === "function";
}

function normalizeHeaderValue(value: HeaderValue | string | null): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0];
  }

  return undefined;
}
