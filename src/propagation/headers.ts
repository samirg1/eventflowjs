import { deserializeEvent } from "./deserializeEvent.js";
import { decryptContextFromPropagation, encryptContextForPropagation } from "./encryptedContext.js";
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
export const ENCRYPTED_CONTEXT_HEADER = "x-eventflow-encrypted-context";
export const EVENT_HEADER = "x-eventflow-event";

export function getPropagationHeaders(
  event: EventLog,
  options?: { encryptionKey?: string },
): Record<string, string> {
  return {
    [TRACE_ID_HEADER]: event.traceId,
    [EVENT_ID_HEADER]: event.id,
    [CONTEXT_HEADER]: JSON.stringify(event.context),
    [ENCRYPTED_CONTEXT_HEADER]: JSON.stringify(
      encryptContextForPropagation(event.encryptedContext, options?.encryptionKey),
    ),
    [EVENT_HEADER]: serializeEvent(event, options),
  };
}

export function extractEventFromHeaders(
  headers: HeadersLike,
  options?: { encryptionKey?: string },
): SerializedPropagationEvent | null {
  const traceId = getHeader(headers, TRACE_ID_HEADER);
  const eventId = getHeader(headers, EVENT_ID_HEADER);
  const contextRaw = getHeader(headers, CONTEXT_HEADER);
  const encryptedContextRaw = getHeader(headers, ENCRYPTED_CONTEXT_HEADER);
  const eventRaw = getHeader(headers, EVENT_HEADER);

  const parsedContext = parseContext(contextRaw);
  const parsedEncryptedContext = parseEncryptedContext(
    encryptedContextRaw,
    options?.encryptionKey,
  );
  const parsedEvent = eventRaw ? deserializeEvent(eventRaw, options) : null;

  if (parsedEvent) {
    return {
      ...parsedEvent,
      id: eventId ?? parsedEvent.id,
      traceId: traceId ?? parsedEvent.traceId,
      context: {
        ...parsedEvent.context,
        ...parsedContext,
      },
      encryptedContext: {
        ...parsedEvent.encryptedContext,
        ...parsedEncryptedContext,
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
    encryptedContext: parsedEncryptedContext,
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

function parseEncryptedContext(
  raw: string | undefined,
  encryptionKey?: string,
): EventContext {
  if (!raw) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  return decryptContextFromPropagation(parsed, encryptionKey);
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
