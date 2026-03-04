/**
 * Terminal status for an event lifecycle.
 */
export type EventStatus = "success" | "failed" | "cancelled";

/**
 * Arbitrary structured context merged into the current event.
 */
export type EventContext = Record<string, unknown>;

/**
 * A point-in-time step captured during event execution.
 */
export interface Step {
  /**
   * Human-readable step label.
   */
  name: string;
  /**
   * Milliseconds elapsed since event start when this step was recorded.
   */
  t: number;
}

/**
 * Call-site information captured when an event starts.
 */
export interface CallerInfo {
  /**
   * Source file path where `startEvent` was called.
   */
  file: string;
  /**
   * 1-based line number in `file`.
   */
  line: number;
  /**
   * Function name when available from stack introspection.
   */
  function?: string;
}

/**
 * Normalized error payload stored on failed events.
 */
export interface EventError {
  /**
   * Error message string.
   */
  message: string;
  /**
   * Error stack trace text, when available.
   */
  stack?: string;
}

/**
 * Canonical event payload emitted to transports.
 */
export interface EventLog {
  /**
   * Unique event identifier (for example, `evt_...`).
   */
  id: string;
  /**
   * Event name provided when the event was started.
   */
  name: string;
  /**
   * Event start time in ISO-8601 format.
   */
  timestamp: string;
  /**
   * Duration in milliseconds from event start to completion.
   */
  duration_ms: number;
  /**
   * Final event status.
   */
  status: EventStatus;
  /**
   * Shallow-merged context object for this event.
   */
  context: EventContext;
  /**
   * Recorded lifecycle steps in capture order.
   */
  steps: Step[];
  /**
   * Error details when `status` is `failed`.
   */
  error?: EventError;
  /**
   * Original call-site details captured at event start.
   */
  caller?: CallerInfo;
  /**
   * Correlation ID shared across related events.
   */
  traceId: string;
  /**
   * Parent event ID when this event continues an existing trace.
   */
  parentId?: string;
}

/**
 * Runtime client behavior flags.
 */
export interface EventFlowClientConfig {
  /**
   * Keep full stack traces on failed events.
   *
   * @default true
   */
  showFullErrorStack: boolean;
  /**
   * Enable `[EventFlow]` console prefixing in `ConsoleTransport`.
   *
   * @default true
   */
  branding: boolean;
}

/**
 * Determines which events a transport may emit.
 */
export type EventEmissionMode = "all" | "errors-only";

/**
 * Per-transport emission behavior.
 *
 * @example
 * ```ts
 * const options: TransportEmissionOptions = {
 *   emissionMode: "errors-only",
 *   debug: true,
 * };
 * ```
 */
export interface TransportEmissionOptions {
  /**
   * Emit all events or only failures.
   *
   * @default "all"
   */
  emissionMode?: EventEmissionMode;
  /**
   * Sampling percent for non-failed events (`0`-`100`).
   *
   * @default 100
   */
  nonErrorSampleRate?: number;
  /**
   * Log debug info when a non-failed event is skipped by filters/sampling.
   *
   * @default false
   */
  debug?: boolean;
}

/**
 * Maps an application account/user object into event-safe context fields.
 */
export type UserContextMapper<TAccount> = (account: TAccount) => EventContext;

/**
 * Configuration shape for clients that do not supply `getUserContext`.
 *
 * @example
 * ```ts
 * EventFlow.configure({ showFullErrorStack: false, branding: true });
 * ```
 */
export interface EventFlowClientConfigureOptions
  extends Partial<EventFlowClientConfig> {
  /**
   * Disallowed in this overload. Use
   * `EventFlowClientConfigureWithUserContext<TAccount>` to configure it.
   */
  getUserContext?: never;
}

/**
 * Configuration shape that enables typed `addUserContext(account)`.
 *
 * @example
 * ```ts
 * EventFlow.configure({
 *   getUserContext: (account: { id: string; email: string }) => ({
 *     id: account.id,
 *     email: account.email,
 *   }),
 * });
 * ```
 */
export interface EventFlowClientConfigureWithUserContext<TAccount>
  extends Partial<EventFlowClientConfig> {
  /**
   * Mapper used by `addUserContext(account)` to populate `context.user`.
   */
  getUserContext: UserContextMapper<TAccount>;
}

/**
 * Callback executed by `run()`. Receives the current event or `null`.
 */
export type RunCallback<T> = (event: EventLog | null) => T | Promise<T>;

/**
 * Runtime behavior for a single `run()` execution.
 *
 * @example
 * ```ts
 * await EventFlow.run("save-order", saveOrder, {
 *   startIfMissing: true,
 *   eventName: "checkout",
 *   statusOnAutoEnd: "success",
 * });
 * ```
 */
export interface RunOptions {
  /**
   * Fail the active event when callback throws.
   *
   * @default true
   */
  failEventOnError?: boolean;
  /**
   * Auto-start an event when none is active.
   *
   * @default false
   */
  startIfMissing?: boolean;
  /**
   * Event name used only when `startIfMissing` starts a new event.
   *
   * Defaults to the provided `stepName`, then `"run"` if no step name exists.
   */
  eventName?: string;
  /**
   * Auto-end events started by this `run()` call.
   *
   * @default true
   */
  endIfStarted?: boolean;
  /**
   * Status used when auto-ending an event started by this `run()` call.
   *
   * @default "success"
   */
  statusOnAutoEnd?: EventStatus;
}

/**
 * Function signature accepted by `instrument()`.
 */
export type InstrumentCallback<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => TResult | Promise<TResult>;

/**
 * Async wrapper signature returned by `instrument()`.
 */
export type InstrumentedFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<Awaited<TResult>>;

/**
 * Options for `instrument(eventName, fn, options)`.
 *
 * @example
 * ```ts
 * const wrapped = EventFlow.instrument("checkout", chargeCard, {
 *   stepName: "charge-card",
 *   contextFromArgs: (input) => ({ cartId: input.cartId }),
 *   contextFromResult: (result) => ({ paymentIntentId: result.id }),
 * });
 * ```
 */
export interface InstrumentOptions<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> extends RunOptions {
  /**
   * Step name recorded for each invocation.
   *
   * @default eventName
   */
  stepName?: string;
  /**
   * Adds context before invoking the wrapped function.
   */
  contextFromArgs?: (...args: TArgs) => EventContext;
  /**
   * Adds context after the wrapped function resolves successfully.
   */
  contextFromResult?: (result: Awaited<TResult>, ...args: TArgs) => EventContext;
}

/**
 * Event shape used for cross-boundary propagation (headers/metadata/tokens).
 */
export interface SerializedPropagationEvent {
  /**
   * Event ID for the continued event.
   */
  id: string;
  /**
   * Event name for the continued event.
   */
  name: string;
  /**
   * Timestamp of the continued event in ISO-8601 format.
   */
  timestamp: string;
  /**
   * Trace correlation ID shared with related events.
   */
  traceId: string;
  /**
   * Parent event ID when known.
   */
  parentId?: string;
  /**
   * Propagated context payload.
   */
  context: EventContext;
  /**
   * Propagated steps (often empty during transport).
   */
  steps: Step[];
}

/**
 * Base transport class for emitted events.
 *
 * @example
 * ```ts
 * import { EventFlow, Transport } from "eventflowjs";
 *
 * // Custom transport that sends events to a remote logging endpoint.
 * class HttpTransport extends Transport {
 *   log(event: Transport.EventLog): void {
 *     void fetch("/logs", {
 *       method: "POST",
 *       headers: { "content-type": "application/json" },
 *       body: JSON.stringify(event),
 *     });
 *   }
 * }
 *
 * EventFlow.setTransport(new HttpTransport({ nonErrorSampleRate: 25 }));
 * ```
 */
export abstract class Transport {
  /**
   * Most recent client configuration applied by EventFlow.
   */
  protected config: EventFlowClientConfig = {
    showFullErrorStack: true,
    branding: true,
  };
  /**
   * Optional emission filters/sampling settings for this transport.
   */
  readonly emissionOptions?: TransportEmissionOptions;

  constructor(emissionOptions?: TransportEmissionOptions) {
    this.emissionOptions = emissionOptions;
  }

  /**
   * Receives emitted events.
   */
  abstract log(event: EventLog): void;

  /**
   * Receives client config updates.
   */
  configure(config: EventFlowClientConfig): void {
    this.config = config;
  }

  /**
   * Debug channel for skipped non-failed events.
   */
  logDebug(message: string, _event: EventLog): void {
    console.log(message);
  }
}

export namespace Transport {
  /**
   * Event payload delivered to `Transport.log(event)`.
   */
  export type EventLog = Parameters<Transport["log"]>[0];
}

/**
 * Mutable per-context state backing `ContextManager` implementations.
 */
export interface ContextState {
  /**
   * Active event for the current async/execution context.
   *
   * @default null
   */
  currentEvent: EventLog | null;
  /**
   * Trace ID shared by events in the current context.
   *
   * @default undefined
   */
  traceId?: string;
}

/**
 * Abstraction for storing/retrieving active event state.
 */
export interface ContextManager {
  /**
   * Returns the active event for the current context.
   */
  getCurrentEvent(): EventLog | null;
  /**
   * Sets the active event for the current context.
   */
  setCurrentEvent(event: EventLog | null): void;
  /**
   * Returns the current trace ID, if present.
   */
  getTraceId(): string | undefined;
  /**
   * Sets the current trace ID.
   */
  setTraceId(traceId: string | undefined): void;
  /**
   * Clears active event and trace state.
   */
  clear(): void;
}

/**
 * Controls how propagation metadata is generated.
 */
export interface PropagationMetadataOptions {
  /**
   * Include serialized event context in metadata.
   *
   * @default true
   */
  includeContext?: boolean;
  /**
   * Maximum string length allowed for each metadata value.
   *
   * @default 500
   */
  maxValueLength?: number;
}

/**
 * Outgoing metadata map used for provider propagation.
 */
export type PropagationMetadata = Record<string, string>;

/**
 * Incoming metadata value shape accepted for extraction.
 */
export type PropagationMetadataInput = Record<
  string,
  string | number | null | undefined
>;

/**
 * Supported HTTP header value shapes.
 */
export type HeaderValue = string | string[] | undefined;

/**
 * Minimal header-reader contract.
 */
export interface HeaderGetter {
  /**
   * Retrieves a header value by case-insensitive name.
   */
  get(name: string): string | null | undefined;
}

/**
 * Header input accepted by `fromHeaders`.
 */
export type HeadersLike =
  | HeaderGetter
  | Record<string, HeaderValue>
  | Headers;
