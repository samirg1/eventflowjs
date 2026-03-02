export type EventStatus = "success" | "failed" | "cancelled";

export type EventContext = Record<string, unknown>;

export interface Step {
  name: string;
  t: number;
}

export interface CallerInfo {
  file: string;
  line: number;
  function?: string;
}

export interface EventError {
  message: string;
  stack?: string;
}

export interface EventLog {
  id: string;
  name: string;
  timestamp: string;
  duration_ms: number;
  status: EventStatus;
  context: EventContext;
  steps: Step[];
  error?: EventError;
  caller?: CallerInfo;
  traceId: string;
  parentId?: string;
}

export interface EventFlowClientConfig {
  showFullErrorStack: boolean;
  branding: boolean;
}

export type EventFlowClientConfigureOptions = Partial<EventFlowClientConfig>;

export type RunCallback<T> = (event: EventLog | null) => T | Promise<T>;

export interface RunOptions {
  failEventOnError?: boolean;
  startIfMissing?: boolean;
  eventName?: string;
  endIfStarted?: boolean;
  statusOnAutoEnd?: EventStatus;
}

export type InstrumentCallback<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => TResult | Promise<TResult>;

export type InstrumentedFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<Awaited<TResult>>;

export interface InstrumentOptions<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> extends RunOptions {
  stepName?: string;
  contextFromArgs?: (...args: TArgs) => EventContext;
  contextFromResult?: (result: Awaited<TResult>, ...args: TArgs) => EventContext;
}

export interface SerializedPropagationEvent {
  id: string;
  name: string;
  timestamp: string;
  traceId: string;
  parentId?: string;
  context: EventContext;
  steps: Step[];
}

export interface Transport {
  log(event: EventLog): void;
  configure?(config: EventFlowClientConfig): void;
}

export interface ContextState {
  currentEvent: EventLog | null;
  traceId?: string;
}

export interface ContextManager {
  getCurrentEvent(): EventLog | null;
  setCurrentEvent(event: EventLog | null): void;
  getTraceId(): string | undefined;
  setTraceId(traceId: string | undefined): void;
  clear(): void;
}

export interface PropagationMetadataOptions {
  includeContext?: boolean;
  maxValueLength?: number;
}

export type PropagationMetadata = Record<string, string>;

export type PropagationMetadataInput = Record<
  string,
  string | number | null | undefined
>;

export type HeaderValue = string | string[] | undefined;

export interface HeaderGetter {
  get(name: string): string | null | undefined;
}

export type HeadersLike =
  | HeaderGetter
  | Record<string, HeaderValue>
  | Headers;
