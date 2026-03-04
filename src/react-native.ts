import { BrowserContext } from "./context/BrowserContext.js";
import { EventFlowClient } from "./EventFlow.js";
import { createEventFlowMiddleware } from "./middleware/node.js";

export const EventFlow: EventFlowClient<never> = new EventFlowClient(new BrowserContext());
export const eventFlowMiddleware = createEventFlowMiddleware(EventFlow);

export { EventFlowClient };
export { createEventFlowMiddleware };
export { ConsoleTransport } from "./transports/ConsoleTransport.js";
export { serializeEvent } from "./propagation/serializeEvent.js";
export { deserializeEvent } from "./propagation/deserializeEvent.js";
export {
  EVENTFLOW_CONTEXT_KEY,
  EVENTFLOW_EVENT_ID_KEY,
  EVENTFLOW_EVENT_NAME_KEY,
  EVENTFLOW_PARENT_ID_KEY,
  EVENTFLOW_TRACE_ID_KEY,
  extractEventFromMetadata,
  getPropagationMetadata,
} from "./propagation/metadata.js";
export {
  EVENT_HEADER,
  EVENT_ID_HEADER,
  TRACE_ID_HEADER,
  CONTEXT_HEADER,
  getPropagationHeaders,
  extractEventFromHeaders,
} from "./propagation/headers.js";
export type {
  CallerInfo,
  ContextManager,
  EventEmissionMode,
  EventFlowClientConfig,
  EventFlowClientConfigureOptions,
  EventFlowClientConfigureWithUserContext,
  EventContext,
  EventError,
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
  Step,
  Transport,
  TransportEmissionOptions,
  UserContextMapper,
} from "./types.js";
export type {
  EventFlowMiddleware,
  EventFlowMiddlewareOptions,
  NextFunction,
  NodeLikeRequest,
  NodeLikeResponse,
} from "./middleware/node.js";
