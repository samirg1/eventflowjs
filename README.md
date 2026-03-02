# EventFlow

<p align="center">
  <img src="./Logo.png" alt="EventFlow logo" width="280" />
</p>

EventFlow is a lightweight TypeScript library for event lifecycle logging.

Instead of scattering many log statements, you create one event, enrich it as work progresses, and emit a final structured log when complete.

## Why EventFlow

- Lifecycle-oriented logging (`start -> enrich -> step -> end`)
- Structured JSON output for easy ingestion and searching
- Works in Node.js, browsers, and fullstack flows
- Async-safe event isolation on Node via `AsyncLocalStorage`
- Dependency-light and easy to embed

## Installation

```bash
npm install eventflowjs
```

## Examples Quickstart

Run a native / web version to try it out here:

- [Live Snack: Checkout Orchestration](https://snack.expo.dev/3gM42hha3w3Iect_0SB5I): frontend -> API -> frontend continuation token flow plus metadata-based webhook continuation with live event panels.

## React Native

EventFlow supports React Native with a dedicated non-Node entrypoint.

- Default import works in RN bundlers that honor the `react-native` package field:
  - `import { EventFlow } from "eventflowjs";`
- You can also import the RN entry explicitly:
  - `import { EventFlow } from "eventflowjs/react-native";`

The RN entry uses in-memory context (no `AsyncLocalStorage`) and is designed for mobile app event lifecycles.

## Quick Start

```ts
import { EventFlow } from "eventflowjs";

EventFlow.startEvent("createUser");
EventFlow.addContext({ userId: 123, email: "test@example.com" });
EventFlow.step("create-db-record");
EventFlow.step("send-email");
EventFlow.endEvent();
```

Example output:

```json
{
  "id": "evt_abc123",
  "name": "createUser",
  "status": "success",
  "timestamp": "2026-03-02T12:00:00.000Z",
  "duration_ms": 124,
  "context": { "userId": 123, "email": "test@example.com" },
  "steps": [
    { "name": "create-db-record", "t": 30 },
    { "name": "send-email", "t": 98 }
  ],
  "caller": { "file": "userService.ts", "line": 42, "function": "createUser" },
  "traceId": "trc_xyz"
}
```

## Client -> Server Propagation

Create headers in the client:

```ts
EventFlow.startEvent("checkout");
EventFlow.addContext({ cartId: "cart_123" });

await fetch("/api/checkout", {
  method: "POST",
  headers: EventFlow.getPropagationHeaders(),
});
```

Continue on the server with middleware:

```ts
import { eventFlowMiddleware } from "eventflowjs";

app.use(eventFlowMiddleware);

// Inside your handler:
EventFlow.step("validate-payment");
EventFlow.addContext({ userId: 42 });
// Middleware auto-ends on response finish.
```

## Run Helper

`EventFlow.run` wraps a function call in a lifecycle-aware step. It catches errors, records failure in the event, and rethrows the error for normal propagation.

```ts
await EventFlow.run("payment", async (event) => {
  await payment();
});
```

Supported call signatures:

```ts
await EventFlow.run("step-name", async (event) => { ... }, options);
await EventFlow.run(async (event) => { ... }, options);
```

Useful options:

- `failEventOnError` (default `true`): call `EventFlow.fail(error)` before rethrowing.
- `startIfMissing` (default `false`): auto-start an event if none exists.
- `eventName`: event name used when `startIfMissing` starts a new event.
- `endIfStarted` (default `true`): auto-end only the event started by this run.
- `statusOnAutoEnd` (default `"success"`): status used when auto-ending.

## Client Configuration

Use `configure` to control client-level behavior:

```ts
EventFlow.configure({ showFullErrorStack: false });
EventFlow.configure({ branding: false });
```

`showFullErrorStack` defaults to `true`. When set to `false`, emitted failed events include only the first two lines of `error.stack`.
`branding` defaults to `true`. When set to `false`, `ConsoleTransport` logs raw JSON without the `[EventFlow]` prefix.

## Instrument Helper

`EventFlow.instrument` creates a reusable wrapped function with the same error behavior as `run`.

```ts
const createUser = EventFlow.instrument("createUser", async (data) => {
  return db.createUser(data);
});

const user = await createUser({ email: "test@example.com" });
```

Defaults are wrapper-friendly:

- auto-start event when missing
- auto-end if the wrapper started it
- fail + rethrow on error

Optional `instrument` options:

- all `run` options (`failEventOnError`, `startIfMissing`, `eventName`, `endIfStarted`, `statusOnAutoEnd`)
- `stepName`: override the step recorded for each call
- `contextFromArgs(...args)`: add context derived from input args
- `contextFromResult(result, ...args)`: add context from the returned value

Headers used:

- `x-eventflow-trace-id`
- `x-eventflow-event-id`
- `x-eventflow-context`
- `x-eventflow-event` (serialized payload)

## Server -> Frontend Continuation

When the server needs to hand an event back to the frontend (for example: create payment intent, then continue UI flow), use continuation tokens:

```ts
// Server handler
EventFlow.fromHeaders(req.headers);
EventFlow.step("create-payment-intent");
EventFlow.addContext({ paymentId: "pi_123" });
const continuationToken = EventFlow.getContinuationToken();
res.json({ paymentId: "pi_123", continuationToken });

// Frontend
EventFlow.continueFromToken(continuationToken);
EventFlow.step("show-payment-sheet");
EventFlow.step("process-payment");
EventFlow.endEvent();
```

## Webhook Continuation (Generic Metadata)

Pass EventFlow metadata to any external system that supports metadata fields:

```ts
const metadata = EventFlow.getPropagationMetadata();
// provider.createAction({ ..., metadata })
```

Continue the event in your webhook handler:

```ts
const attached = EventFlow.fromMetadata(providerObject.metadata);
if (!attached) {
  EventFlow.startEvent("provider-webhook");
}
EventFlow.step("webhook-received");
EventFlow.endEvent();
```

## Transport Extension

```ts
import type { EventLog, Transport } from "eventflowjs";

class HttpTransport implements Transport {
  log(event: EventLog): void {
    void fetch("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  }
}

EventFlow.setTransport(new HttpTransport());
```

## Examples

### Primary mock apps

- [Mock Todo Web App](examples/mock-todo-web/README.md): runnable browser-only todo demo with live event progression and emitted-event panels.
- [Mock Todo React Native App](examples/mock-todo-rn/README.md): runnable RN todo app with local event debugger panel.

Both primary mock apps are suitable for manual smoke testing of propagation flows (`headers`, `continuationToken`, `metadata`).

## API Reference

### Primary Exports

| Export | Description |
| --- | --- |
| `EventFlow` | Singleton `EventFlowClient` instance used for lifecycle logging. |
| `EventFlowClient` | Class implementation behind the `EventFlow` singleton. |
| `eventflowjs/react-native` | React Native entrypoint that exports `EventFlow` wired to browser-style in-memory context. |
| `eventFlowMiddleware` | Ready-to-use Node/Express middleware (`app.use(eventFlowMiddleware)`). |
| `ConsoleTransport` | Built-in JSON console transport. |

### Utility Functions

| Function | Description | Arguments | Returns |
| --- | --- | --- | --- |
| `createEventFlowMiddleware(client, options?)` | Factory for custom middleware behavior. | `client: compatible EventFlow client`, `options?: EventFlowMiddlewareOptions` | `EventFlowMiddleware` |
| `serializeEvent(event)` | Serializes an event payload for transport. | `event: EventLog` | `string` |
| `deserializeEvent(data)` | Parses serialized propagation payload safely. | `data: string` | `SerializedPropagationEvent or null` |
| `getPropagationHeaders(event)` | Builds header propagation map from event. | `event: EventLog` | `Record<string, string>` |
| `extractEventFromHeaders(headers)` | Rehydrates propagation payload from headers. | `headers: HeadersLike` | `SerializedPropagationEvent or null` |
| `getPropagationMetadata(event, options?)` | Builds metadata propagation map from event. | `event: EventLog`, `options?: PropagationMetadataOptions` | `PropagationMetadata` |
| `extractEventFromMetadata(metadata)` | Rehydrates propagation payload from metadata map. | `metadata: PropagationMetadataInput` | `SerializedPropagationEvent or null` |

### `EventFlow` Methods

| Method | Description | Arguments | Returns |
| --- | --- | --- | --- |
| `startEvent(name)` | Starts a new event. Auto-cancels and emits any currently active event first. | `name: string` | `EventLog` |
| `addContext(data)` | Shallow-merges context into the active event. No-op if no active event exists. | `data: EventContext` | `void` |
| `step(name)` | Appends a step with elapsed time from event start. | `name: string` | `void` |
| `endEvent(status?)` | Completes and emits the active event. | `status?: EventStatus` (default `"success"`) | `EventLog or null` |
| `fail(error)` | Marks active event as failed, captures error, emits, clears current event. | `error: unknown` | `EventLog or null` |
| `configure(options)` | Updates client-level behavior settings. | `options: EventFlowClientConfigureOptions` | `void` |
| `getCurrentEvent()` | Returns current active event in context. | none | `EventLog or null` |
| `setTransport(transport)` | Replaces transport(s) used for emitting events. | `transport: Transport or Transport[]` | `void` |
| `getPropagationHeaders()` | Builds propagation headers from active event. | none | `Record<string, string>` |
| `fromHeaders(headers)` | Rehydrates and attaches event from propagation headers. | `headers: HeadersLike` | `EventLog or null` |
| `attach(event)` | Attaches a provided event payload as current active event. | `event: EventLog or SerializedPropagationEvent` | `EventLog` |
| `getContinuationToken(event?)` | Serializes an event for server->client or worker continuation. | `event?: EventLog` (defaults to current event) | `string or null` |
| `continueFromToken(token)` | Restores and attaches an event from a continuation token. | `token: string` | `EventLog or null` |
| `getPropagationMetadata(event?, options?)` | Produces provider-friendly metadata fields for continuation. | `event?: EventLog`, `options?: PropagationMetadataOptions` | `PropagationMetadata` |
| `fromMetadata(metadata)` | Restores and attaches an event from metadata fields. | `metadata: PropagationMetadataInput` | `EventLog or null` |
| `run(stepName?, fn, options?)` | Runs callback with optional step, captures+rethrows errors, optional auto-start/auto-end behavior. | overloads: `run(fn, options?)`, `run(stepName, fn, options?)` | `Promise<T>` |
| `instrument(eventName, fn, options?)` | Wraps a function in event lifecycle instrumentation for reuse. | `eventName: string`, `fn: (...args) => T`, `options?: InstrumentOptions` | `(...args) => Promise<T>` |

### `RunOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `failEventOnError` | `boolean` | `true` | Calls `EventFlow.fail(error)` before rethrow when callback throws. |
| `startIfMissing` | `boolean` | `false` | Auto-starts an event if none is active. |
| `eventName` | `string` | inferred | Event name used when auto-starting. |
| `endIfStarted` | `boolean` | `true` | Auto-ends event only if this `run` started it. |
| `statusOnAutoEnd` | `EventStatus` | `"success"` | Status used for auto-end path. |

### `EventFlowClientConfigureOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `showFullErrorStack` | `boolean` | `true` | When `false`, failed events include only the first two lines of `error.stack`. |
| `branding` | `boolean` | `true` | When `false`, `ConsoleTransport` logs plain JSON without the branding prefix. |

### `InstrumentOptions`

`InstrumentOptions` extends `RunOptions` and adds:

| Option | Type | Description |
| --- | --- | --- |
| `stepName` | `string` | Step name recorded for each instrumented call (defaults to `eventName`). |
| `contextFromArgs` | `(...args) => EventContext` | Adds context from function input arguments. |
| `contextFromResult` | `(result, ...args) => EventContext` | Adds context from function result. |

### Middleware

| Export | Description | Arguments |
| --- | --- | --- |
| `eventFlowMiddleware` | Default middleware instance using global `EventFlow`. | `(req, res, next)` |
| `createEventFlowMiddleware(client, options?)` | Creates middleware around any compatible client (`startEvent`, `addContext`, `endEvent`, `fail`, `fromHeaders`). | `client: compatible EventFlow client`, `options?: EventFlowMiddlewareOptions` |

`EventFlowMiddlewareOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `eventName` | `string or (req) => string` | `http:${method} ${url}` | Event name for non-propagated requests. |
| `mapContext` | `(req) => EventContext` | `undefined` | Adds custom request-derived context. |
| `includeRequestContext` | `boolean` | `true` | Adds `method` and `url` context automatically. |
| `failOn5xx` | `boolean` | `true` | Marks event as failed when response status is `>= 500`. |
| `autoEnd` | `boolean` | `true` | Ends events automatically on `finish`/`close`. |

### Propagation Constants

| Constant | Value |
| --- | --- |
| `TRACE_ID_HEADER` | `"x-eventflow-trace-id"` |
| `EVENT_ID_HEADER` | `"x-eventflow-event-id"` |
| `CONTEXT_HEADER` | `"x-eventflow-context"` |
| `EVENT_HEADER` | `"x-eventflow-event"` |
| `EVENTFLOW_TRACE_ID_KEY` | `"eventflow_trace_id"` |
| `EVENTFLOW_EVENT_ID_KEY` | `"eventflow_event_id"` |
| `EVENTFLOW_EVENT_NAME_KEY` | `"eventflow_event_name"` |
| `EVENTFLOW_PARENT_ID_KEY` | `"eventflow_parent_id"` |
| `EVENTFLOW_CONTEXT_KEY` | `"eventflow_context"` |

### Exported Types

`EventStatus`, `EventContext`, `Step`, `CallerInfo`, `EventError`, `EventLog`, `EventFlowClientConfig`, `EventFlowClientConfigureOptions`, `SerializedPropagationEvent`, `Transport`, `ContextManager`, `HeadersLike`, `RunCallback`, `RunOptions`, `InstrumentCallback`, `InstrumentedFunction`, `InstrumentOptions`, `PropagationMetadata`, `PropagationMetadataInput`, `PropagationMetadataOptions`, `EventFlowMiddleware`, `EventFlowMiddlewareOptions`, `NodeLikeRequest`, `NodeLikeResponse`, `NextFunction`.
