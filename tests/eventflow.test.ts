import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleTransport,
  EventFlow,
  eventFlowMiddleware,
  extractEventFromHeaders,
  serializeEvent,
  deserializeEvent,
  type EventLog,
  type Transport,
} from "../src/index.js";

class MemoryTransport implements Transport {
  events: EventLog[] = [];

  log(event: EventLog): void {
    this.events.push(event);
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
}

describe("EventFlow", () => {
  let memory: MemoryTransport;

  beforeEach(() => {
    memory = new MemoryTransport();
    EventFlow.setTransport(memory);
    EventFlow.configure({ showFullErrorStack: true, branding: true });
  });

  afterEach(() => {
    const active = EventFlow.getCurrentEvent();
    if (active) {
      EventFlow.endEvent("cancelled");
    }
  });

  it("tracks event lifecycle and emits structured logs", () => {
    EventFlow.startEvent("createUser");
    EventFlow.addContext({ userId: 123, email: "test@example.com" });
    EventFlow.step("create-db-record");
    EventFlow.step("send-email");

    const ended = EventFlow.endEvent();

    expect(ended).not.toBeNull();
    expect(ended?.name).toBe("createUser");
    expect(ended?.status).toBe("success");
    expect(ended?.context.userId).toBe(123);
    expect(ended?.steps).toHaveLength(2);
    expect(ended?.caller?.file).toBeTypeOf("string");
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].id).toBe(ended?.id);
  });

  it("merges context shallowly", () => {
    EventFlow.startEvent("merge-context");
    EventFlow.addContext({ a: 1, nested: { keep: true } });
    EventFlow.addContext({ b: 2, nested: { overwrite: true } });

    const ended = EventFlow.endEvent();

    expect(ended?.context).toEqual({
      a: 1,
      b: 2,
      nested: { overwrite: true },
    });
  });

  it("records step timing from start", async () => {
    EventFlow.startEvent("timing");
    await delay(10);
    EventFlow.step("first");
    await delay(5);
    EventFlow.step("second");

    const ended = EventFlow.endEvent();

    expect(ended?.steps[0].t).toBeGreaterThanOrEqual(0);
    expect(ended?.steps[1].t).toBeGreaterThanOrEqual(ended?.steps[0].t ?? 0);
  });

  it("captures error message and stack when failing", () => {
    EventFlow.startEvent("failure");

    const failed = EventFlow.fail(new Error("boom"));

    expect(failed?.status).toBe("failed");
    expect(failed?.error?.message).toBe("boom");
    expect(failed?.error?.stack).toContain("Error: boom");
    expect(memory.events[0].status).toBe("failed");
  });

  it("truncates error stack to two lines when configured", () => {
    EventFlow.configure({ showFullErrorStack: false });
    EventFlow.startEvent("failure");

    const error = new Error("boom");
    error.stack = ["Error: boom", " at top", " at second", " at third"].join("\n");

    const failed = EventFlow.fail(error);

    expect(failed?.error?.stack).toBe("Error: boom\n at top");
    expect(memory.events[0].error?.stack).toBe("Error: boom\n at top");
  });

  it("console transport includes branding prefix by default", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      EventFlow.setTransport(new ConsoleTransport());
      EventFlow.startEvent("branding-default");
      EventFlow.endEvent();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("[Event");
    } finally {
      spy.mockRestore();
    }
  });

  it("console transport omits branding prefix when disabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      EventFlow.setTransport(new ConsoleTransport());
      EventFlow.configure({ branding: false });
      EventFlow.startEvent("branding-off");
      EventFlow.endEvent();

      expect(spy).toHaveBeenCalledTimes(1);
      const output = String(spy.mock.calls[0][0]);
      expect(output).not.toContain("[Event");
      expect(output.trimStart().startsWith("{")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("isolates active events across async flows", async () => {
    const [a, b] = await Promise.all([
      runConcurrentFlow("flow-a", 2, 6),
      runConcurrentFlow("flow-b", 4, 3),
    ]);

    expect(a?.name).toBe("flow-a");
    expect(b?.name).toBe("flow-b");
    expect(a?.id).not.toBe(b?.id);
    expect(a?.steps.map((step) => step.name)).toEqual(["step-1", "step-2"]);
    expect(b?.steps.map((step) => step.name)).toEqual(["step-1", "step-2"]);
  });

  it("serializes and deserializes propagated events", () => {
    EventFlow.startEvent("checkout");
    EventFlow.addContext({ cartId: "c1" });
    EventFlow.step("prepare");

    const current = EventFlow.getCurrentEvent();
    expect(current).not.toBeNull();

    const serialized = serializeEvent(current as EventLog);
    const deserialized = deserializeEvent(serialized);

    expect(deserialized).not.toBeNull();
    expect(deserialized?.id).toBe(current?.id);
    expect(deserialized?.name).toBe("checkout");
    expect(deserialized?.context.cartId).toBe("c1");
  });

  it("extracts propagation data from headers and tolerates invalid context", () => {
    const headers = {
      "x-eventflow-trace-id": "trc_abc",
      "x-eventflow-event-id": "evt_abc",
      "x-eventflow-context": "{invalid-json}",
      "x-eventflow-event": JSON.stringify({
        id: "evt_abc",
        name: "checkout",
        traceId: "trc_abc",
        timestamp: new Date().toISOString(),
        context: { fromPayload: true },
        steps: [],
      }),
    };

    const extracted = extractEventFromHeaders(headers);

    expect(extracted).not.toBeNull();
    expect(extracted?.id).toBe("evt_abc");
    expect(extracted?.traceId).toBe("trc_abc");
    expect(extracted?.context).toEqual({ fromPayload: true });
  });

  it("auto-cancels an existing event when starting a new one", () => {
    EventFlow.startEvent("first");
    EventFlow.step("one");

    const second = EventFlow.startEvent("second");
    const done = EventFlow.endEvent();

    expect(memory.events).toHaveLength(2);
    expect(memory.events[0].name).toBe("first");
    expect(memory.events[0].status).toBe("cancelled");
    expect(second.name).toBe("second");
    expect(done?.name).toBe("second");
  });

  it("can attach an event from headers and continue it", () => {
    const timestamp = new Date().toISOString();
    const headers = {
      "x-eventflow-event": JSON.stringify({
        id: "evt_client",
        name: "checkout",
        traceId: "trc_shared",
        timestamp,
        context: { cartId: "c42" },
        steps: [{ name: "prepare", t: 10 }],
      }),
      "x-eventflow-event-id": "evt_client",
      "x-eventflow-trace-id": "trc_shared",
      "x-eventflow-context": JSON.stringify({ source: "server" }),
    };

    const attached = EventFlow.fromHeaders(headers);
    EventFlow.step("validate-payment");
    const ended = EventFlow.endEvent();

    expect(attached?.id).toBe("evt_client");
    expect(ended?.id).toBe("evt_client");
    expect(ended?.traceId).toBe("trc_shared");
    expect(ended?.context).toEqual({ cartId: "c42", source: "server" });
    expect(ended?.steps.at(-1)?.name).toBe("validate-payment");
  });

  it("middleware starts and ends an event automatically", () => {
    const req = { headers: {}, method: "GET", url: "/users" };
    const res = new MockResponse();

    let nextCalled = false;
    eventFlowMiddleware(req, res, () => {
      nextCalled = true;
      EventFlow.step("handler");
    });

    res.emit("finish");

    expect(nextCalled).toBe(true);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].name).toBe("http:GET /users");
    expect(memory.events[0].status).toBe("success");
    expect(memory.events[0].context).toMatchObject({
      method: "GET",
      url: "/users",
    });
    expect(memory.events[0].steps.map((step) => step.name)).toContain("handler");
  });

  it("middleware keeps propagated event id and trace id", () => {
    const req = {
      method: "POST",
      url: "/checkout",
      headers: {
        "x-eventflow-event": JSON.stringify({
          id: "evt_client",
          name: "checkout",
          traceId: "trc_shared",
          timestamp: new Date().toISOString(),
          context: { cartId: "c99" },
          steps: [],
        }),
        "x-eventflow-event-id": "evt_client",
        "x-eventflow-trace-id": "trc_shared",
        "x-eventflow-context": JSON.stringify({ source: "browser" }),
      },
    };
    const res = new MockResponse();

    eventFlowMiddleware(req, res, () => {
      EventFlow.step("server-handler");
    });
    res.emit("finish");

    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].id).toBe("evt_client");
    expect(memory.events[0].traceId).toBe("trc_shared");
    expect(memory.events[0].name).toBe("checkout");
    expect(memory.events[0].context).toMatchObject({
      cartId: "c99",
      source: "browser",
      method: "POST",
      url: "/checkout",
    });
  });

  it("middleware marks event failed on 5xx responses", () => {
    const req = { headers: {}, method: "GET", url: "/boom" };
    const res = new MockResponse();
    res.statusCode = 503;

    eventFlowMiddleware(req, res, () => {});
    res.emit("finish");

    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].status).toBe("failed");
  });

  it("continues an event from a server token back on the client", () => {
    EventFlow.startEvent("checkout");
    EventFlow.step("press-pay");
    EventFlow.addContext({ cartId: "c123" });

    const token = EventFlow.getContinuationToken();
    expect(token).toBeTypeOf("string");

    EventFlow.endEvent();

    const attached = EventFlow.continueFromToken(token as string);
    EventFlow.step("show-payment-sheet");
    EventFlow.step("process-payment");
    const ended = EventFlow.endEvent();

    expect(attached).not.toBeNull();
    expect(ended?.id).toBe(attached?.id);
    expect(ended?.steps.map((step) => step.name)).toEqual([
      "press-pay",
      "show-payment-sheet",
      "process-payment",
    ]);
  });

  it("creates and consumes generic metadata for webhook continuation", () => {
    EventFlow.startEvent("checkout");
    EventFlow.addContext({ orderId: "ord_1", userId: 9 });
    const metadata = EventFlow.getPropagationMetadata();
    EventFlow.endEvent();

    const attached = EventFlow.fromMetadata(metadata);
    EventFlow.step("webhook-received");
    const ended = EventFlow.endEvent();

    expect(attached).not.toBeNull();
    expect(ended?.id).toBe(attached?.id);
    expect(ended?.traceId).toBe(attached?.traceId);
    expect(ended?.name).toBe("checkout");
    expect(ended?.context).toMatchObject({ orderId: "ord_1", userId: 9 });
  });

  it("returns null when continuation token is invalid", () => {
    const attached = EventFlow.continueFromToken("{not-json}");
    expect(attached).toBeNull();
  });

  it("runs a named step with callback and returns result", async () => {
    EventFlow.startEvent("checkout");

    const result = await EventFlow.run("payment", async (event) => {
      expect(event?.name).toBe("checkout");
      EventFlow.addContext({ phase: "in-run" });
      return "ok";
    });

    const ended = EventFlow.endEvent();

    expect(result).toBe("ok");
    expect(ended?.context).toMatchObject({ phase: "in-run" });
    expect(ended?.steps.map((step) => step.name)).toContain("payment");
  });

  it("captures error via fail and rethrows from run", async () => {
    EventFlow.startEvent("checkout");

    await expect(
      EventFlow.run("payment", async () => {
        throw new Error("declined");
      }),
    ).rejects.toThrow("declined");

    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].status).toBe("failed");
    expect(memory.events[0].error?.message).toBe("declined");
    expect(memory.events[0].steps.map((step) => step.name)).toContain("payment");
    expect(EventFlow.getCurrentEvent()).toBeNull();
  });

  it("can auto-start and auto-end inside run", async () => {
    const value = await EventFlow.run(
      "payment",
      async (event) => {
        expect(event?.name).toBe("checkout-auto");
        return 42;
      },
      {
        startIfMissing: true,
        eventName: "checkout-auto",
        endIfStarted: true,
      },
    );

    expect(value).toBe(42);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].name).toBe("checkout-auto");
    expect(memory.events[0].status).toBe("success");
    expect(memory.events[0].steps.map((step) => step.name)).toContain("payment");
  });

  it("supports run without a step name", async () => {
    EventFlow.startEvent("checkout");
    await EventFlow.run(async (event) => {
      expect(event?.name).toBe("checkout");
      EventFlow.addContext({ mode: "no-step" });
    });

    const ended = EventFlow.endEvent();
    expect(ended?.context).toMatchObject({ mode: "no-step" });
    expect(ended?.steps).toHaveLength(0);
  });

  it("instruments a function and auto-starts an event", async () => {
    const createUser = EventFlow.instrument(
      "createUser",
      async (data: { id: number; email: string }) => {
        return { ...data, created: true };
      },
    );

    const result = await createUser({ id: 1, email: "a@test.com" });

    expect(result).toEqual({ id: 1, email: "a@test.com", created: true });
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].name).toBe("createUser");
    expect(memory.events[0].status).toBe("success");
    expect(memory.events[0].steps.map((step) => step.name)).toContain("createUser");
  });

  it("instrument marks failed and rethrows errors", async () => {
    const createUser = EventFlow.instrument("createUser", async () => {
      throw new Error("db-failed");
    });

    await expect(createUser()).rejects.toThrow("db-failed");

    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].status).toBe("failed");
    expect(memory.events[0].error?.message).toBe("db-failed");
  });

  it("instrument supports context hooks and custom step names", async () => {
    const createUser = EventFlow.instrument(
      "createUser",
      async (data: { id: number; email: string }) => {
        return { userId: data.id };
      },
      {
        stepName: "db.create-user",
        contextFromArgs: (data) => ({ email: data.email }),
        contextFromResult: (result) => ({ userId: result.userId }),
      },
    );

    await createUser({ id: 2, email: "b@test.com" });

    expect(memory.events).toHaveLength(1);
    expect(memory.events[0].steps.map((step) => step.name)).toContain("db.create-user");
    expect(memory.events[0].context).toMatchObject({
      email: "b@test.com",
      userId: 2,
    });
  });

  it("react-native entry exports a working EventFlow instance", async () => {
    const rnModule = await import("../src/react-native.js");
    const rnMemory = new MemoryTransport();
    rnModule.EventFlow.setTransport(rnMemory);

    rnModule.EventFlow.startEvent("rn-checkout");
    rnModule.EventFlow.step("press-pay");
    const ended = rnModule.EventFlow.endEvent();

    expect(ended?.name).toBe("rn-checkout");
    expect(rnMemory.events).toHaveLength(1);
    expect(rnMemory.events[0].steps.map((step) => step.name)).toContain("press-pay");
  });
});

async function runConcurrentFlow(
  name: string,
  firstDelayMs: number,
  secondDelayMs: number,
): Promise<EventLog | null> {
  await delay(firstDelayMs);
  EventFlow.startEvent(name);
  EventFlow.step("step-1");
  await delay(secondDelayMs);
  EventFlow.step("step-2");
  return EventFlow.endEvent();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
