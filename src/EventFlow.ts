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
} from "./types.js";

export class EventFlowClient {
  private transports: Transport[];

  constructor(
    private contextManager: ContextManager,
    transports: Transport[] = [new ConsoleTransport()],
  ) {
    this.transports = transports;
  }

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

  addContext(data: EventContext): void {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return;
    }

    const record = EventRecord.fromLog(existing);
    record.mergeContext(data);
    this.contextManager.setCurrentEvent(record.toLog());
  }

  step(name: string): void {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return;
    }

    const record = EventRecord.fromLog(existing);
    record.addStep(name);
    this.contextManager.setCurrentEvent(record.toLog());
  }

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

  fail(error: unknown): EventLog | null {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return null;
    }

    const failed = EventRecord.fromLog(existing).fail(error);
    this.emit(failed);
    this.contextManager.setCurrentEvent(null);
    return failed;
  }

  getCurrentEvent(): EventLog | null {
    return this.contextManager.getCurrentEvent();
  }

  setTransport(transport: Transport | Transport[]): void {
    this.transports = Array.isArray(transport) ? transport : [transport];
  }

  getPropagationHeaders(): Record<string, string> {
    const existing = this.contextManager.getCurrentEvent();
    if (!existing) {
      return {};
    }

    return getPropagationHeaders(existing);
  }

  fromHeaders(headers: HeadersLike): EventLog | null {
    const extracted = extractEventFromHeaders(headers);
    if (!extracted) {
      return null;
    }

    return this.attach(extracted);
  }

  getContinuationToken(event?: EventLog): string | null {
    const target = event ?? this.contextManager.getCurrentEvent();
    if (!target) {
      return null;
    }

    return serializeEvent(target);
  }

  continueFromToken(token: string): EventLog | null {
    const parsed = deserializeEvent(token);
    if (!parsed) {
      return null;
    }

    return this.attach(parsed);
  }

  getPropagationMetadata(
    event?: EventLog,
    options?: PropagationMetadataOptions,
  ): PropagationMetadata {
    const target = event ?? this.contextManager.getCurrentEvent();
    if (!target) {
      return {};
    }

    return getPropagationMetadata(target, options);
  }

  fromMetadata(metadata: PropagationMetadataInput): EventLog | null {
    const extracted = extractEventFromMetadata(metadata);
    if (!extracted) {
      return null;
    }

    return this.attach(extracted);
  }

  async run<T>(
    fn: RunCallback<T>,
    options?: RunOptions,
  ): Promise<Awaited<T>>;
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
      transport.log(event);
    }
  }
}

function isEventLog(event: EventLog | SerializedPropagationEvent): event is EventLog {
  return "status" in event;
}

function createTraceId(): string {
  return generateId().replace(/^evt_/, "trc_");
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
