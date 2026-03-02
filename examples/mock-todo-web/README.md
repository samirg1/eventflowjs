# Mock Todo Web App

## What This Demonstrates

- Browser lifecycle tracking for todo CRUD actions.
- Header-based propagation from browser to Node API.
- Continuation token handoff from server back to client.
- Metadata-based continuation for webhook-style processing.
- Live event debugger panels for client and server emitted events.

## Prerequisites

- Node.js 18+
- Project dependencies installed from the repository root (`npm install`)

## Run Locally

From the repository root:

```bash
npm run build
node examples/mock-todo-web/server.mjs
```

Then open: `http://127.0.0.1:4310`

## What To Try

1. Add, toggle, and delete todos from the UI.
2. Watch `Client Active Event` update as each action progresses.
3. Watch `Client Emitted Events` and `Server Emitted Events` when events emit.
4. Click `Simulate Provider Webhook` to test metadata continuation.

## Testing Note

This mock app is suitable for manual smoke testing of propagation behavior across `headers`, `continuationToken`, and `metadata`.

## Companion Mobile Demo

See the React Native companion app: [Mock Todo React Native App](../mock-todo-rn/README.md).
