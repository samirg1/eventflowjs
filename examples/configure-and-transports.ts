import {
  ConsoleTransport,
  EventFlow,
  type EventFlowClient,
  type EventLog,
  type Transport,
  type TransportEmissionOptions,
} from "../src/index.js";

// Simple custom transport that stores emitted events in memory.
// It intentionally does not implement any filtering logic.
class MemoryTransport implements Transport {
  events: EventLog[] = [];
  readonly emissionOptions?: TransportEmissionOptions;

  constructor(emissionOptions?: TransportEmissionOptions) {
    this.emissionOptions = emissionOptions;
  }

  log(event: EventLog): void {
    this.events.push(event);
  }
}

type Account = { id: string; email: string };
const AppEventFlow: EventFlowClient<never> = EventFlow;
const memory = new MemoryTransport({ nonErrorSampleRate: 100 });

// Different transports can use different emission options:
// - Console: only failed events (plus debug marker for suppressed successes)
// - Memory: all non-failed events (100% sample rate)
AppEventFlow.setTransport([
  new ConsoleTransport({
    emissionMode: "errors-only",
    debug: true,
  }),
  memory,
]);

// Client-level behavior is configured separately from transport emission.
AppEventFlow.configure({
  showFullErrorStack: false,
  branding: true,
});

// Auto types future getUserContext calls to ensure consistent user context shape across the app.
AppEventFlow.configure({
  getUserContext: (account: Account) => ({
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
