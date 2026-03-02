# Mock Todo Web App (Browser-Only Demo)

## What This Demonstrates

- Full lifecycle logging with `startEvent`, `addContext`, `step`, `endEvent`, and `fail`.
- Header propagation into a mock API (`getPropagationHeaders` -> `fromHeaders`).
- Continuation token handoff (`getContinuationToken` -> `continueFromToken`).
- Metadata continuation for webhook-style flows (`getPropagationMetadata` -> `fromMetadata`).
- `run(...)` and `instrument(...)` helpers in both client and mock server paths.
- Custom transports collecting emitted client/server events for live debugger panels.

## Architecture

- `public/app.js`: browser UI and EventFlow client flow orchestration.
- `server.mjs`: in-memory mock API module using a dedicated `EventFlowClient`.
- No HTTP server process is required for API behavior. The browser calls the mock server directly.

## Prerequisites

- Node.js 18+
- Repo dependencies installed (`npm install`)

## Run Locally

From repository root:

```bash
npm run build
python3 -m http.server 4310
```

Open:

- `http://127.0.0.1:4310/examples/mock-todo-web/public/index.html`

## What To Try

1. Create, toggle, and delete todos.
2. Click **Simulate Checkout Flow** to see propagation and continuation token flow.
3. Click **Simulate Webhook Flow** to see metadata continuation flow.
4. Click **Simulate Failure Flow** to generate failed lifecycle events.
5. Inspect `Client Active Event`, `Client Emitted Events`, and `Server Emitted Events`.

## Companion Mobile Demo

See the React Native companion app: [Mock Todo React Native App](../mock-todo-rn/README.md).
