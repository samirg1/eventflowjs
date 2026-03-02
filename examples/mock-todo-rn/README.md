# Mock Todo React Native App

## What This Demonstrates

- EventFlow usage through `eventflowjs/react-native`.
- Client lifecycle tracking for todo CRUD actions.
- Header-based server propagation and continuation token handoff.
- Metadata-based webhook continuation.
- In-app debugger panes for active, client-emitted, and server-emitted events.

## Prerequisites

1. Start the backend from the required web demo first.
2. Expo-compatible mobile environment (iOS simulator, Android emulator, or device).

## Required Backend + Browser Demo

Run the backend from: [Mock Todo Web App](../mock-todo-web/README.md)

From the repository root:

```bash
npm run build
node examples/mock-todo-web/server.mjs
```

## Run Locally

From this directory (`examples/mock-todo-rn`):

```bash
npm install
npm run start
```

## Backend URL Notes

- iOS simulator usually works with `http://127.0.0.1:4310`
- Android emulator usually needs `http://10.0.2.2:4310`

You can edit the backend URL directly in the app UI.

## What To Try

1. Load todos and confirm the `Client Active Event` panel updates.
2. Create, toggle, and delete todos and inspect emitted client/server events.
3. Trigger `Simulate Webhook` and verify metadata continuation behavior.
4. Change backend URL in the app UI to test local network setups.

## Testing Note

This mock app is suitable for manual smoke testing of propagation behavior across `headers`, `continuationToken`, and `metadata`.
