# Mock Todo React Native App

## What This Demonstrates

- EventFlow usage through `eventflowjs/react-native`.
- Client lifecycle tracking for todo CRUD actions.
- Header-based server propagation and continuation token handoff.
- Metadata-based webhook continuation.
- In-app debugger panes for active, client-emitted, and server-emitted events.

## Prerequisites

1. A compatible local backend exposing `/api/todos`, `/api/debug/events`, and `/api/webhook/todo-sync`.
2. Expo-compatible mobile environment (iOS simulator, Android emulator, or device).

## Backend Setup

The web demo is now browser-only (in-memory mock API) and does not launch a network backend.
For RN, run your own local backend that follows the same endpoint contract.

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
