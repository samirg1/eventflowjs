import { EventRecord } from "./Event.js";
import { extractEventFromHeaders, getPropagationHeaders } from "./propagation/headers.js";
import { deserializeEvent } from "./propagation/deserializeEvent.js";
import {
  extractEventFromMetadata,
  getPropagationMetadata,
} from "./propagation/metadata.js";
import { serializeEvent } from "./propagation/serializeEvent.js";
import { ConsoleTransport } from "./transports/ConsoleTransport.js";
import { generateId } from "./utils/generateId.js";
import { getCallerInfo } from "./utils/getCallerInfo.js";
import type {
  ContextManager,
  EventEmissionMode,
  EventFlowClientConfig,
  EventFlowClientConfigureOptions,
  EventFlowClientConfigureWithUserContext,
  EventContext,
  EventLog,
  EventStatus,
  HeadersLike,
  InstrumentCallback,
  InstrumentedFunction,
  InstrumentOptions,
  PropagationMetadata,
  PropagationMetadataInput,
  PropagationMetadataOptions,
  RunCallback,
  RunOptions,
  SerializedPropagationEvent,
  Transport,
  TransportEmissionOptions,
  UserContextMapper,
} from "./types.js";

export class EventFlowClient<TAccount = never> {
  private transports: Transport[];
  private declare readonly __userContextType: (account: TAccount) => TAccount;
  private config: EventFlowClientConfig = {
    showFullErrorStack: true,
    branding: true,
    prefix: "",
  };
  private encryptionKey?: string;
  private userContextMapper?: UserContextMapper<unknown>;

  constructor(
    private contextManager: ContextManager,
    transports: Transport[] = [new ConsoleTransport()],
  ) {
    this.transports = transports;
    this.validateTransportEmissionOptions();
    this.applyConfigToTransports();
  }

  /**
   * Starts a new active event.
   *
   * If an event is already active in the current context, it is automatically
   * completed with `cancelled` status and emitted before the new event starts.
   *
   * @param name Human-readable event name (for example, `checkout`).
   * @returns The newly started event log snapshot.
   */
  startEvent(name: string): EventLog {
    const existing = this.contextManager.getCurrentEvent();
    if (existing) {
      const cancelled = EventRecord.fromLog(existing).complete("cancelled");
      this.emit(cancelled);
    }

    const traceId = this.contextManager.getTraceId() ?? createTraceId();
    this.contextManager.setTraceId(traceId);

    const record = new EventRecord({
      id: generateId(),
      name,
      traceId,
      caller: getCallerInfo(),
    });

    const log = record.toLog();
    this.contextManager.setCurrentEvent(log);
    return log;
  }

  /**
   * Adds structured context fields to the active event.
   *
   * Context is shallow-merged into existing context keys. If no event is active,
   * this call is a no-op.
   *
   * @param data Key-value context fields to merge into the current event.
   */
  addContext(data: EventContext): void {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return;
    }

    const record = EventRecord.fromLog(existing);
    record.mergeContext(data);
    this.contextManager.setCurrentEvent(record.toLog());
  }

  /**
   * Adds structured context fields that should be encrypted during propagation.
   *
   * Data remains decrypted on the active event and in emitted logs, but its
   * values are encrypted in propagation headers, continuation tokens, and
   * propagation metadata.
   *
   * Requires `configure({ encryptionKey })` to be set first. If no event is
   * active, this call is a no-op.
   *
   * @param data Key-value context fields to merge into `encryptedContext`.
   */
  addEncryptedContext(data: EventContext): void {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return;
    }

    this.assertEncryptionConfigured();

    const record = EventRecord.fromLog(existing);
    record.mergeEncryptedContext(data);
    this.contextManager.setCurrentEvent(record.toLog());
  }

  /**
   * Maps and adds a user/account object to `context.user` for the active event.
   *
   * Requires `configure({ getUserContext })` to be set first. If no event is
   * active, this call is a no-op.
   *
   * @param account User/account object expected by configured mapper.
   */
  addUserContext(account: TAccount): void {
    if (!this.userContextMapper) {
      throw new TypeError(
        "EventFlow.addUserContext requires configure({ getUserContext }) before use.",
      );
    }

    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return;
    }

    const mapped = this.userContextMapper(account);
    if (typeof mapped !== "object" || mapped === null) {
      throw new TypeError(
        "EventFlow getUserContext must return a non-null object.",
      );
    }

    if (existing.context.user !== undefined) {
      console.warn(
        "EventFlow.addUserContext overwriting existing context.user value.",
      );
    }

    this.addContext({ user: mapped as EventContext });
  }

  /**
   * Records a lifecycle step on the active event.
   *
   * Step timing is measured as elapsed milliseconds from event start. If no
   * event is active, this call is a no-op.
   *
   * @param name Step name to append.
   */
  step(name: string): void {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return;
    }

    const record = EventRecord.fromLog(existing);
    record.addStep(`${this.config.prefix}${name}`);
    this.contextManager.setCurrentEvent(record.toLog());
  }

  /**
   * Ends and emits the active event.
   *
   * @param status Final event status. Defaults to `success`.
   * @returns The completed event log, or `null` when no event is active.
   */
  endEvent(status: EventStatus = "success"): EventLog | null {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return null;
    }

    const completed = EventRecord.fromLog(existing).complete(status);
    this.emit(completed);
    this.contextManager.setCurrentEvent(null);
    return completed;
  }

  /**
   * Marks the active event as failed, captures error details, emits it, and
   * clears the active context.
   *
   * Behavior respects client config:
   * - `showFullErrorStack: true` (default): keep full stack trace
   * - `showFullErrorStack: false`: keep only the first two stack lines
   *
   * @param error Unknown thrown value to capture.
   * @returns The failed event log, or `null` when no event is active.
   */
  fail(error: unknown): EventLog | null {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return null;
    }

    const failedWithStack = EventRecord.fromLog(existing).fail(error);
    const failed = this.config.showFullErrorStack
      ? failedWithStack
      : truncateErrorStack(failedWithStack, 2);
    this.emit(failed);
    this.contextManager.setCurrentEvent(null);
    return failed;
  }

  /**
   * Returns the active event for the current context.
   *
   * @returns Current event log, or `null` if none is active.
   */
  getCurrentEvent(): EventLog | null {
    return this.contextManager.getCurrentEvent();
  }

  /**
   * Replaces the active transport(s) used when events are emitted.
   *
   * The current client configuration is applied to new transports when set.
   *
   * @param transport One transport or an array of transports.
   */
  setTransport(transport: Transport | Transport[]): void {
    this.transports = Array.isArray(transport) ? transport : [transport];
    this.validateTransportEmissionOptions();
    this.applyConfigToTransports();
  }

  /**
   * Updates client-level runtime behavior.
   *
   * Current supported options:
   * - `showFullErrorStack` (default `true`)
   * - `branding` (default `true`, used by `ConsoleTransport`)
   * - `prefix` (default `""`, prepended to `step(...)` names)
   * - `encryptionKey` (optional shared key for `encryptedContext` propagation)
   * - `transports` (optional replacement transport or transports)
   *
   * @param options Partial configuration values to merge with current config.
   */
  configure(options: EventFlowClientConfigureOptions): void;
  configure<TNextAccount = TAccount>(
    options: EventFlowClientConfigureWithUserContext<TNextAccount>,
  ): asserts this is EventFlowClient<TNextAccount>;
  configure(
    options:
      | EventFlowClientConfigureOptions
      | EventFlowClientConfigureWithUserContext<unknown>,
  ): void {
    if ("getUserContext" in options) {
      this.userContextMapper = options.getUserContext;
    }
    if ("encryptionKey" in options) {
      this.encryptionKey = options.encryptionKey;
    }

    const nextConfig: Partial<EventFlowClientConfig> = {};
    if (options.showFullErrorStack !== undefined) {
      nextConfig.showFullErrorStack = options.showFullErrorStack;
    }
    if (options.branding !== undefined) {
      nextConfig.branding = options.branding;
    }
    if ("prefix" in options) {
      nextConfig.prefix = options.prefix ?? "";
    }

    this.config = {
      ...this.config,
      ...nextConfig,
    };
    if (options.transports !== undefined) {
      this.setTransport(options.transports);
      return;
    }

    this.applyConfigToTransports();
  }

  /**
   * Builds propagation headers from the active event.
   *
   * These headers can be attached to outgoing HTTP requests so downstream
   * services can continue the same event/trace.
   *
   * @returns Header map, or an empty object when no event is active.
   */
  getPropagationHeaders(): Record<string, string> {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return {};
    }

    return getPropagationHeaders(existing, {
      encryptionKey: this.encryptionKey,
    });
  }

  /**
   * Extracts an event payload from incoming propagation headers and attaches it
   * as the active event in the current context.
   *
   * @param headers Incoming request headers.
   * @returns Attached event log, or `null` if headers do not contain a valid
   * propagation payload.
   */
  fromHeaders(headers: HeadersLike): EventLog | null {
    const extracted = extractEventFromHeaders(headers, {
      encryptionKey: this.encryptionKey,
    });
    if (!extracted) {
      return null;
    }

    return this.attach(extracted);
  }

  /**
   * Serializes an event into a continuation token.
   *
   * Use this when handing event state from one boundary to another (for example,
   * server -> client continuation flows).
   *
   * @param event Optional explicit event. Defaults to the active event.
   * @returns Serialized token, or `null` when no target event exists.
   */
  getContinuationToken(event?: EventLog): string | null {
    const target = event ?? this.contextManager.getCurrentEvent();
    if (!target) {
      return null;
    }

    return serializeEvent(target, {
      encryptionKey: this.encryptionKey,
    });
  }

  /**
   * Restores and attaches an event from a continuation token.
   *
   * @param token Serialized event token from `getContinuationToken`.
   * @returns Attached event log, or `null` if parsing fails.
   */
  continueFromToken(token: string): EventLog | null {
    const parsed = deserializeEvent(token, {
      encryptionKey: this.encryptionKey,
    });
    if (!parsed) {
      return null;
    }

    return this.attach(parsed);
  }

  /**
   * Builds metadata fields for providers that support generic key-value
   * metadata (for example, payment providers and webhook-capable systems).
   *
   * @param event Optional explicit event. Defaults to the active event.
   * @param options Metadata shaping options.
   * @returns Metadata object, or an empty object when no target event exists.
   */
  getPropagationMetadata(
    event?: EventLog,
    options?: PropagationMetadataOptions,
  ): PropagationMetadata {
    const target = event ?? this.contextManager.getCurrentEvent();
    if (!target) {
      return {};
    }

    return getPropagationMetadata(target, {
      ...options,
      encryptionKey: this.encryptionKey,
    });
  }

  /**
   * Extracts an event from generic metadata fields and attaches it as active.
   *
   * @param metadata Provider metadata map.
   * @returns Attached event log, or `null` if metadata does not contain a valid
   * propagation payload.
   */
  fromMetadata(metadata: PropagationMetadataInput): EventLog | null {
    const extracted = extractEventFromMetadata(metadata, {
      encryptionKey: this.encryptionKey,
    });
    if (!extracted) {
      return null;
    }

    return this.attach(extracted);
  }

  /**
   * Runs a callback with optional step tracking and error lifecycle handling.
   *
   * Supported signatures:
   * - `run(fn, options?)`
   * - `run(stepName, fn, options?)`
   *
   * On thrown errors, the callback error is rethrown after optional event
   * failure handling (`failEventOnError`, default `true`).
   *
   * @param fn Callback to execute.
   * @param options Runtime behavior options for this invocation.
   * @returns Callback result.
   */
  async run<T>(
    fn: RunCallback<T>,
    options?: RunOptions,
  ): Promise<Awaited<T>>;
  /**
   * Runs a callback while recording a named step before execution.
   *
   * @param stepName Step name to record.
   * @param fn Callback to execute.
   * @param options Runtime behavior options for this invocation.
   * @returns Callback result.
   */
  async run<T>(
    stepName: string,
    fn: RunCallback<T>,
    options?: RunOptions,
  ): Promise<Awaited<T>>;
  async run<T>(
    stepNameOrFn: string | RunCallback<T>,
    fnOrOptions?: RunCallback<T> | RunOptions,
    maybeOptions?: RunOptions,
  ): Promise<Awaited<T>> {
    const { stepName, fn, options } = parseRunArguments(
      stepNameOrFn,
      fnOrOptions,
      maybeOptions,
    );

    const {
      failEventOnError = true,
      startIfMissing = false,
      eventName,
      endIfStarted = true,
      statusOnAutoEnd = "success",
    } = options ?? {};

    let startedHere = false;
    if (!this.getCurrentEvent() && startIfMissing) {
      this.startEvent(eventName ?? stepName ?? "run");
      startedHere = true;
    }

    if (stepName) {
      this.step(stepName);
    }

    const active = this.getCurrentEvent();

    try {
      const result = await fn(active);
      if (startedHere && endIfStarted) {
        this.endEvent(statusOnAutoEnd);
      }
      return result as Awaited<T>;
    } catch (error) {
      if (failEventOnError && this.getCurrentEvent()) {
        this.fail(error);
      } else if (startedHere && endIfStarted && this.getCurrentEvent()) {
        this.endEvent("failed");
      }

      throw error;
    }
  }

  /**
   * Wraps a function with EventFlow lifecycle instrumentation for reuse.
   *
   * The returned function:
   * - auto-starts an event when missing (default)
   * - records a step for each invocation
   * - auto-ends if the wrapper started the event (default)
   * - fails + rethrows on callback errors (default)
   *
   * @param eventName Event name for auto-started events.
   * @param fn Function to instrument.
   * @param options Instrument behavior and context hooks.
   * @returns An async function that executes the wrapped lifecycle behavior.
   */
  instrument<TArgs extends unknown[], TResult>(
    eventName: string,
    fn: InstrumentCallback<TArgs, TResult>,
    options: InstrumentOptions<TArgs, TResult> = {},
  ): InstrumentedFunction<TArgs, TResult> {
    const {
      stepName = eventName,
      contextFromArgs,
      contextFromResult,
      ...runOverrides
    } = options;

    return async (...args: TArgs): Promise<Awaited<TResult>> => {
      return this.run(
        stepName,
        async () => {
          if (contextFromArgs) {
            this.addContext(contextFromArgs(...args));
          }

          const result = (await fn(...args)) as Awaited<TResult>;

          if (contextFromResult) {
            this.addContext(contextFromResult(result, ...args));
          }

          return result;
        },
        {
          startIfMissing: runOverrides.startIfMissing ?? true,
          eventName: runOverrides.eventName ?? eventName,
          endIfStarted: runOverrides.endIfStarted ?? true,
          failEventOnError: runOverrides.failEventOnError ?? true,
          statusOnAutoEnd: runOverrides.statusOnAutoEnd ?? "success",
        },
      );
    };
  }

  /**
   * Attaches an existing event payload as the current active event.
   *
   * Useful for continuing an event that was previously serialized, propagated,
   * or reconstructed from external data.
   *
   * @param event Full event log or serialized propagation shape.
   * @returns The attached event log snapshot.
   */
  attach(event: EventLog | SerializedPropagationEvent): EventLog {
    const record = isEventLog(event)
      ? EventRecord.fromLog(event)
      : EventRecord.fromPropagation(event);

    const log = record.toLog();
    this.contextManager.setTraceId(log.traceId);
    this.contextManager.setCurrentEvent(log);
    return log;
  }

  private emit(event: EventLog): void {
    for (const transport of this.transports) {
      const options = resolveTransportEmissionOptions(transport.emissionOptions);
      if (!shouldEmitEvent(event, options)) {
        if (options.debug && event.status === "success") {
          const message = "Successful Event";
          if (transport.logDebug) {
            transport.logDebug(message, event);
          } else {
            console.log(message);
          }
        }
        continue;
      }

      transport.log(event);
    }
  }

  private validateTransportEmissionOptions(): void {
    for (const transport of this.transports) {
      resolveTransportEmissionOptions(transport.emissionOptions);
    }
  }

  private applyConfigToTransports(): void {
    for (const transport of this.transports) {
      transport.configure?.(this.config);
    }
  }

  private assertEncryptionConfigured(): void {
    if (!this.encryptionKey) {
      throw new TypeError(
        "EventFlow.addEncryptedContext requires configure({ encryptionKey }) before use.",
      );
    }
  }
}

function isEventLog(event: EventLog | SerializedPropagationEvent): event is EventLog {
  return "status" in event;
}

function createTraceId(): string {
  return generateId().replace(/^evt_/, "trc_");
}

function truncateErrorStack(event: EventLog, maxLines: number): EventLog {
  const eventError = event.error;
  const stack = eventError?.stack;
  if (!eventError || !stack) {
    return event;
  }

  const lines = stack.split("\n");
  if (lines.length <= maxLines) {
    return event;
  }

  return {
    ...event,
    error: {
      message: eventError.message,
      stack: lines.slice(0, maxLines).join("\n"),
    },
  };
}

function parseRunArguments<T>(
  stepNameOrFn: string | RunCallback<T>,
  fnOrOptions?: RunCallback<T> | RunOptions,
  maybeOptions?: RunOptions,
): {
  stepName?: string;
  fn: RunCallback<T>;
  options?: RunOptions;
} {
  if (typeof stepNameOrFn === "string") {
    if (typeof fnOrOptions !== "function") {
      throw new TypeError("EventFlow.run requires a function to execute.");
    }

    return {
      stepName: stepNameOrFn,
      fn: fnOrOptions,
      options: maybeOptions,
    };
  }

  if (typeof fnOrOptions === "function") {
    throw new TypeError(
      "EventFlow.run received an unexpected function argument. " +
        "Use run(stepName, fn, options?) or run(fn, options?).",
    );
  }

  return {
    fn: stepNameOrFn,
    options: fnOrOptions as RunOptions | undefined,
  };
}

function shouldEmitEvent(
  event: EventLog,
  options: ResolvedTransportEmissionOptions,
): boolean {
  if (event.status === "failed") {
    return true;
  }

  if (options.emissionMode === "errors-only") {
    return false;
  }

  return passesSampleRate(options.nonErrorSampleRate);
}

function passesSampleRate(percent: number): boolean {
  if (percent <= 0) {
    return false;
  }

  if (percent >= 100) {
    return true;
  }

  return Math.random() * 100 < percent;
}

function resolveTransportEmissionOptions(
  options?: TransportEmissionOptions,
): ResolvedTransportEmissionOptions {
  const emissionMode = validateEmissionMode(options?.emissionMode ?? "all");
  const nonErrorSampleRate = validateNonErrorSampleRate(
    options?.nonErrorSampleRate ?? 100,
  );
  const debug = validateDebugOption(options?.debug ?? false);

  return {
    emissionMode,
    nonErrorSampleRate,
    debug,
  };
}

function validateEmissionMode(value: EventEmissionMode): EventEmissionMode {
  if (value === "all" || value === "errors-only") {
    return value;
  }

  throw new TypeError(
    "EventFlow transport emission option `emissionMode` must be either \"all\" or \"errors-only\".",
  );
}

function validateNonErrorSampleRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(
      "EventFlow transport emission option `nonErrorSampleRate` must be a number between 0 and 100.",
    );
  }

  return value;
}

function validateDebugOption(value: boolean): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(
      "EventFlow transport emission option `debug` must be a boolean.",
    );
  }

  return value;
}

type ResolvedTransportEmissionOptions = {
  /**
   * Normalized transport emission mode.
   *
   * @default "all"
   */
  emissionMode: EventEmissionMode;
  /**
   * Normalized sample rate for non-failed events.
   *
   * @default 100
   */
  nonErrorSampleRate: number;
  /**
   * Normalized debug toggle.
   *
   * @default false
   */
  debug: boolean;
};
