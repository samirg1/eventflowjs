import {
  ConsoleTransport,
  EventFlow,
  Transport,
  type EventFlowClient,
} from "../src/index.js";

// Simple custom transport that stores emitted events in memory.
// It intentionally does not implement any filtering logic.
class MemoryTransport extends Transport {
  events: Transport.EventLog[] = [];

  log(event: Transport.EventLog): void {
    this.events.push(event);
  }
}

type Account = { id: string; email: string };
const AppEventFlow: EventFlowClient = EventFlow;
const memory = new MemoryTransport({ nonErrorSampleRate: 100 });

// Configure client behavior and transport replacement in one call.
// Different transports can use different emission options:
// - Console: only failed events (plus debug marker for suppressed successes)
// - Memory: all non-failed events (100% sample rate)
AppEventFlow.configure({
  showFullErrorStack: false,
  branding: true,
  transports: [
    new ConsoleTransport({
      emissionMode: "errors-only",
      debug: true,
    }),
    memory,
  ],
});

// Auto types future getUserContext calls to ensure consistent user context shape across the app.
AppEventFlow.configure<Account>({
  getUserContext: (account) => ({
    id: account.id,
    email: account.email,
  }),
});

// Successful event:
// - ConsoleTransport does not emit full payload (errors-only) and prints "Successful Event"
// - MemoryTransport captures full event payload
AppEventFlow.startEvent("checkout-success");
AppEventFlow.addUserContext({ id: "u_123", email: "user@example.com" });
AppEventFlow.step("validate-cart");
AppEventFlow.endEvent();

// Failed event:
// - Emitted to both transports because failed events always emit
AppEventFlow.startEvent("checkout-failure");
AppEventFlow.addUserContext({ id: "u_456", email: "user2@example.com" });
try {
  throw new Error("payment-declined");
} catch (error) {
  AppEventFlow.fail(error);
}

// Expect 2 events in memory: one success + one failure.
console.log(`Memory transport captured ${memory.events.length} events.`);
