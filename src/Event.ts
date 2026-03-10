import { createStep } from "./Step.js";
import type {
  CallerInfo,
  EventContext,
  EventError,
  EventLog,
  EventStatus,
  SerializedPropagationEvent,
  Step,
} from "./types.js";

/**
 * Constructor payload used to build an `EventRecord`.
 */
interface EventRecordParams {
  /**
   * Stable event ID.
   */
  id: string;
  /**
   * Event name.
   */
  name: string;
  /**
   * Trace correlation ID.
   */
  traceId: string;
  /**
   * Parent event ID for propagated events.
   */
  parentId?: string;
  /**
   * Event start time in ISO-8601 format.
   *
   * @default new Date(now).toISOString()
   */
  timestamp?: string;
  /**
   * Initial event context.
   *
   * @default {}
   */
  context?: EventContext;
  /**
   * Initial encrypted event context.
   *
   * @default {}
   */
  encryptedContext?: EventContext;
  /**
   * Initial steps list.
   *
   * @default []
   */
  steps?: Step[];
  /**
   * Captured caller details.
   */
  caller?: CallerInfo;
  /**
   * Initial error payload.
   */
  error?: EventError;
  /**
   * Initial status.
   *
   * @default "success"
   */
  status?: EventStatus;
  /**
   * Initial duration in milliseconds.
   *
   * @default 0
   */
  durationMs?: number;
  /**
   * Epoch milliseconds used as start baseline for elapsed step timings.
   *
   * @default parsed timestamp, or now if timestamp is invalid
   */
  startedAtMs?: number;
}

export class EventRecord {
  private readonly startedAtMs: number;
  private readonly timestamp: string;
  private readonly caller?: CallerInfo;
  private readonly id: string;
  private readonly name: string;
  private readonly traceId: string;
  private readonly parentId?: string;
  private context: EventContext;
  private encryptedContext: EventContext;
  private steps: Step[];
  private status: EventStatus;
  private durationMs: number;
  private error?: EventError;

  constructor(params: EventRecordParams) {
    const nowMs = Date.now();
    const timestamp = params.timestamp ?? new Date(nowMs).toISOString();
    const parsedTimestamp = Date.parse(timestamp);
    const resolvedParsedTimestamp = Number.isNaN(parsedTimestamp)
      ? nowMs
      : parsedTimestamp;
    const startedAtMs = params.startedAtMs ?? resolvedParsedTimestamp;

    this.id = params.id;
    this.name = params.name;
    this.traceId = params.traceId;
    this.parentId = params.parentId;
    this.timestamp = timestamp;
    this.startedAtMs = startedAtMs;
    this.context = { ...(params.context ?? {}) };
    this.encryptedContext = { ...(params.encryptedContext ?? {}) };
    this.steps = [...(params.steps ?? [])];
    this.caller = params.caller;
    this.error = params.error;
    this.status = params.status ?? "success";
    this.durationMs = params.durationMs ?? 0;
  }

  static fromLog(event: EventLog): EventRecord {
    const parsedStart = Date.parse(event.timestamp);
    const startedAtMs = Number.isNaN(parsedStart)
      ? Date.now()
      : parsedStart;

    return new EventRecord({
      id: event.id,
      name: event.name,
      traceId: event.traceId,
      parentId: event.parentId,
      timestamp: event.timestamp,
      context: event.context,
      encryptedContext: event.encryptedContext,
      steps: event.steps,
      caller: event.caller,
      error: event.error,
      status: event.status,
      durationMs: event.duration_ms,
      startedAtMs,
    });
  }

  static fromPropagation(event: SerializedPropagationEvent): EventRecord {
    const parsedStart = Date.parse(event.timestamp);
    return new EventRecord({
      id: event.id,
      name: event.name,
      traceId: event.traceId,
      parentId: event.parentId,
      timestamp: event.timestamp,
      context: event.context,
      encryptedContext: event.encryptedContext,
      steps: event.steps,
      startedAtMs: Number.isNaN(parsedStart) ? Date.now() : parsedStart,
    });
  }

  mergeContext(data: EventContext): void {
    this.context = {
      ...this.context,
      ...data,
    };
  }

  mergeEncryptedContext(data: EventContext): void {
    this.encryptedContext = {
      ...this.encryptedContext,
      ...data,
    };
  }

  addStep(name: string): void {
    this.steps.push(createStep(name, this.startedAtMs));
  }

  complete(status: EventStatus = "success"): EventLog {
    this.status = status;
    this.durationMs = Math.max(0, Date.now() - this.startedAtMs);
    return this.toLog();
  }

  fail(error: unknown): EventLog {
    this.status = "failed";
    this.durationMs = Math.max(0, Date.now() - this.startedAtMs);
    this.error = toEventError(error);
    return this.toLog();
  }

  toLog(): EventLog {
    return {
      id: this.id,
      name: this.name,
      timestamp: this.timestamp,
      duration_ms: this.durationMs,
      status: this.status,
      context: { ...this.context },
      encryptedContext: { ...this.encryptedContext },
      steps: [...this.steps],
      error: this.error,
      caller: this.caller,
      traceId: this.traceId,
      parentId: this.parentId,
    };
  }
}

function toEventError(error: unknown): EventError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
