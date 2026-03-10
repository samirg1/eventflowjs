import {
  decryptContextFromPropagation,
  encryptContextForPropagation,
} from "./encryptedContext.js";
import type {
  EventLog,
  PropagationMetadata,
  PropagationMetadataInput,
  PropagationMetadataOptions,
  SerializedPropagationEvent,
} from "../types.js";

export const EVENTFLOW_TRACE_ID_KEY = "eventflow_trace_id";
export const EVENTFLOW_EVENT_ID_KEY = "eventflow_event_id";
export const EVENTFLOW_EVENT_NAME_KEY = "eventflow_event_name";
export const EVENTFLOW_PARENT_ID_KEY = "eventflow_parent_id";
export const EVENTFLOW_CONTEXT_KEY = "eventflow_context";
export const EVENTFLOW_ENCRYPTED_CONTEXT_KEY = "eventflow_encrypted_context";

const DEFAULT_MAX_METADATA_VALUE_LENGTH = 500;

export function getPropagationMetadata(
  event: EventLog,
  options: PropagationMetadataOptions = {},
): PropagationMetadata {
  const {
    includeContext = true,
    maxValueLength = DEFAULT_MAX_METADATA_VALUE_LENGTH,
  } = options;

  const metadata: PropagationMetadata = {
    [EVENTFLOW_TRACE_ID_KEY]: event.traceId,
    [EVENTFLOW_EVENT_ID_KEY]: event.id,
    [EVENTFLOW_EVENT_NAME_KEY]: event.name,
  };

  if (event.parentId) {
    metadata[EVENTFLOW_PARENT_ID_KEY] = event.parentId;
  }

  if (includeContext) {
    const context = JSON.stringify(event.context);
    if (context.length <= maxValueLength) {
      metadata[EVENTFLOW_CONTEXT_KEY] = context;
    }

    const encryptedContext = JSON.stringify(
      encryptContextForPropagation(event.encryptedContext, options.encryptionKey),
    );
    if (encryptedContext.length <= maxValueLength) {
      metadata[EVENTFLOW_ENCRYPTED_CONTEXT_KEY] = encryptedContext;
    }
  }

  return metadata;
}

export function extractEventFromMetadata(
  metadata: PropagationMetadataInput,
  options?: { encryptionKey?: string },
): SerializedPropagationEvent | null {
  const traceId = toStringOrUndefined(metadata[EVENTFLOW_TRACE_ID_KEY]);
  const id = toStringOrUndefined(metadata[EVENTFLOW_EVENT_ID_KEY]);
  const name = toStringOrUndefined(metadata[EVENTFLOW_EVENT_NAME_KEY]);

  if (!traceId || !id || !name) {
    return null;
  }

  return {
    id,
    name,
    traceId,
    parentId: toStringOrUndefined(metadata[EVENTFLOW_PARENT_ID_KEY]),
    timestamp: new Date().toISOString(),
    context: parseContext(toStringOrUndefined(metadata[EVENTFLOW_CONTEXT_KEY])),
    encryptedContext: parseEncryptedContext(
      toStringOrUndefined(metadata[EVENTFLOW_ENCRYPTED_CONTEXT_KEY]),
      options?.encryptionKey,
    ),
    steps: [],
  };
}

function toStringOrUndefined(
  value: string | number | null | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function parseContext(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function parseEncryptedContext(
  raw: string | undefined,
  encryptionKey?: string,
): Record<string, unknown> {
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
