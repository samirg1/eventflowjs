import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleTransport,
  EventFlow,
  Transport,
  type EventFlowClient,
  eventFlowMiddleware,
  extractEventFromHeaders,
  getPropagationHeaders,
  serializeEvent,
  deserializeEvent,
  type EventLog,
  type TransportEmissionOptions,
} from "../src/index.js";

class MemoryTransport extends Transport {
  events: Transport.EventLog[] = [];

  log(event: Transport.EventLog): void {
    this.events.push(event);
  }
}

class EmissionAwareMemoryTransport extends Transport {
  events: Transport.EventLog[] = [];
  debugMessages: string[] = [];

  constructor(emissionOptions?: TransportEmissionOptions) {
    super(emissionOptions);
  }

  log(event: Transport.EventLog): void {
    this.events.push(event);
  }

  logDebug(message: string): void {
    this.debugMessages.push(message);
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
    (
      EventFlow as unknown as {
        configure(options: {
          showFullErrorStack?: boolean;
          branding?: boolean;
          prefix?: string;
          encryptionKey?: string;
          getUserContext?: undefined;
        }): void;
      }
    ).configure({
      showFullErrorStack: true,
      branding: true,
      prefix: undefined,
      encryptionKey: undefined,
      getUserContext: undefined,
    });
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

  it("adds mapped user context under context.user", () => {
    type Account = { uid: string; email: string };

    EventFlow.configure({
      getUserContext: (account: Account) => ({
        email: account.email,
        id: account.uid,
      }),
    });

    EventFlow.startEvent("user-context");
    EventFlow.addUserContext({ uid: "u_1", email: "test@example.com" });
    const ended = EventFlow.endEvent();

    expect(ended?.context.user).toEqual({
      email: "test@example.com",
      id: "u_1",
    });
  });

  it("throws when addUserContext is called before configuring getUserContext", () => {
    const untyped = EventFlow as unknown as EventFlowClient<unknown>;
    expect(() => untyped.addUserContext({ uid: "u_1" })).toThrow(
      "EventFlow.addUserContext requires configure({ getUserContext }) before use.",
    );
  });

  it("addUserContext is a no-op with no active event", () => {
    type Account = { uid: string; email: string };

    EventFlow.configure({
      getUserContext: (account: Account) => ({
        email: account.email,
        id: account.uid,
      }),
    });

    EventFlow.addUserContext({ uid: "u_2", email: "noevent@example.com" });

    expect(EventFlow.getCurrentEvent()).toBeNull();
    expect(memory.events).toHaveLength(0);
  });

  it("throws when addEncryptedContext is called before configuring encryptionKey", () => {
    EventFlow.startEvent("missing-encryption-key");

    expect(() => {
      EventFlow.addEncryptedContext({ secret: "shh" });
    }).toThrow(
      "EventFlow.addEncryptedContext requires configure({ encryptionKey }) before use.",
    );
  });

  it("warns and overwrites existing context.user when adding user context", () => {
    type Account = { uid: string; email: string };

    EventFlow.configure({
      getUserContext: (account: Account) => ({
        email: account.email,
        id: account.uid,
      }),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      EventFlow.startEvent("overwrite-user-context");
      EventFlow.addContext({ user: { legacy: true } });
      EventFlow.addUserContext({ uid: "u_3", email: "overwrite@example.com" });
      const ended = EventFlow.endEvent();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(ended?.context.user).toEqual({
        email: "overwrite@example.com",
        id: "u_3",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws when getUserContext returns a non-object value", () => {
    type Account = { uid: string };


    EventFlow.startEvent("invalid-user-context");
    expect(() => {
          EventFlow.configure({
            getUserContext: (_account: Account) => "invalid" as unknown as Record<string, unknown>,
          });
          EventFlow.addUserContext({ uid: "u_4" })
      }).toThrow(
      "EventFlow getUserContext must return a non-null object.",
    );
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

  it("prepends configured prefix to recorded steps", () => {
    EventFlow.configure({ prefix: "client: " });
    EventFlow.startEvent("prefixed-steps");

    EventFlow.step("checkout:start");

    const ended = EventFlow.endEvent();

    expect(ended?.steps).toHaveLength(1);
    expect(ended?.steps[0].name).toBe("client: checkout:start");
  });

  it("clears the configured prefix when set to undefined", () => {
    EventFlow.configure({ prefix: "client: " });
    EventFlow.configure({ prefix: undefined });
    EventFlow.startEvent("cleared-prefix");

    EventFlow.step("checkout:start");

    const ended = EventFlow.endEvent();

    expect(ended?.steps[0].name).toBe("checkout:start");
  });

  it("captures error message and stack when failing", () => {
    EventFlow.startEvent("failure");

    const failed = EventFlow.fail(new Error("boom"));

    expect(failed?.status).toBe("failed");
    expect(failed?.error?.message).toBe("boom");
    expect(failed?.error?.stack).toContain("Error: boom");
    expect(memory.events[0].status).toBe("failed");
  });

  it("keeps encrypted context decrypted on the active event and emitted log", () => {
    EventFlow.configure({ encryptionKey: "shared-secret" });
    EventFlow.startEvent("encrypted-context");
    EventFlow.addEncryptedContext({
      secret: "sensitive-value",
      profile: { plan: "pro" },
    });

    const current = EventFlow.getCurrentEvent();
    const ended = EventFlow.endEvent();

    expect(current?.encryptedContext).toEqual({
      secret: "sensitive-value",
      profile: { plan: "pro" },
    });
    expect(ended?.encryptedContext).toEqual({
      secret: "sensitive-value",
      profile: { plan: "pro" },
    });
    expect(memory.events[0].encryptedContext).toEqual({
      secret: "sensitive-value",
      profile: { plan: "pro" },
    });
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

  it("replaces transports when provided via configure", () => {
    const other = new MemoryTransport();

    EventFlow.configure({ transports: other });
    EventFlow.startEvent("configure-replace-transport");
    EventFlow.endEvent();

    expect(memory.events).toHaveLength(0);
    expect(other.events).toHaveLength(1);
    expect(other.events[0].name).toBe("configure-replace-transport");
  });

  it("applies config and transport replacement in a single configure call", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      EventFlow.configure({
        branding: false,
        transports: new ConsoleTransport(),
      });
      EventFlow.startEvent("configure-branding-and-transport");
      EventFlow.endEvent();

      expect(spy).toHaveBeenCalledTimes(1);
      const output = String(spy.mock.calls[0][0]);
      expect(output).not.toContain("[Event");
      expect(output.trimStart().startsWith("{")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("console transport can emit only failed events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      EventFlow.setTransport(new ConsoleTransport({ emissionMode: "errors-only" }));

      EventFlow.startEvent("success-hidden");
      EventFlow.endEvent();
      expect(spy).not.toHaveBeenCalled();

      EventFlow.startEvent("failure-shown");
      EventFlow.fail(new Error("boom"));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('"status": "failed"');
    } finally {
      spy.mockRestore();
    }
  });

  it("samples non-failed events by configured percentage", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.8)
      .mockReturnValueOnce(0.2);

    try {
      EventFlow.setTransport(new ConsoleTransport({ nonErrorSampleRate: 50 }));

      EventFlow.startEvent("sampled-out");
      EventFlow.endEvent();

      EventFlow.startEvent("sampled-in");
      EventFlow.endEvent();

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0][0])).toContain('"name": "sampled-in"');
      expect(randomSpy).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("debug mode prints a simple success marker when success payload is suppressed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      EventFlow.setTransport(new ConsoleTransport({
        emissionMode: "errors-only",
        debug: true,
      }));

      EventFlow.startEvent("hidden-success");
      EventFlow.endEvent();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("Successful Event");
    } finally {
      spy.mockRestore();
    }
  });

  it("throws for invalid transport nonErrorSampleRate values", () => {
    expect(
      () => EventFlow.setTransport(new ConsoleTransport({ nonErrorSampleRate: -1 })),
    ).toThrow(
      "EventFlow transport emission option `nonErrorSampleRate` must be a number between 0 and 100.",
    );
    expect(
      () => EventFlow.setTransport(new ConsoleTransport({ nonErrorSampleRate: 101 })),
    ).toThrow(
      "EventFlow transport emission option `nonErrorSampleRate` must be a number between 0 and 100.",
    );
  });

  it("applies emission options to custom transports without custom emit logic", () => {
    const transport = new EmissionAwareMemoryTransport({
      emissionMode: "errors-only",
      debug: true,
    });
    EventFlow.setTransport(transport);

    EventFlow.startEvent("suppressed-success");
    EventFlow.endEvent();

    EventFlow.startEvent("visible-failure");
    EventFlow.fail(new Error("boom"));

    expect(transport.events).toHaveLength(1);
    expect(transport.events[0].status).toBe("failed");
    expect(transport.debugMessages).toEqual(["Successful Event"]);
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
    EventFlow.configure({ encryptionKey: "shared-secret" });
    EventFlow.startEvent("checkout");
    EventFlow.addContext({ cartId: "c1" });
    EventFlow.addEncryptedContext({ clientSecret: "pi_secret_123" });
    EventFlow.step("prepare");

    const current = EventFlow.getCurrentEvent();
    expect(current).not.toBeNull();

    const serialized = serializeEvent(current as EventLog, {
      encryptionKey: "shared-secret",
    });
    const deserialized = deserializeEvent(serialized, {
      encryptionKey: "shared-secret",
    });

    expect(deserialized).not.toBeNull();
    expect(deserialized?.id).toBe(current?.id);
    expect(deserialized?.name).toBe("checkout");
    expect(deserialized?.context.cartId).toBe("c1");
    expect(deserialized?.encryptedContext.clientSecret).toBe("pi_secret_123");
    expect(serialized).not.toContain("pi_secret_123");
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
        encryptedContext: {},
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
    EventFlow.configure({ encryptionKey: "shared-secret" });
    const timestamp = new Date().toISOString();
    const headers = getPropagationHeaders(
      {
        id: "evt_client",
        name: "checkout",
        status: "success",
        timestamp,
        duration_ms: 0,
        context: { cartId: "c42" },
        encryptedContext: { clientSecret: "pi_secret_123" },
        steps: [{ name: "prepare", t: 10 }],
        traceId: "trc_shared",
      } as EventLog,
      {
        encryptionKey: "shared-secret",
      },
    );
    headers["x-eventflow-context"] = JSON.stringify({ source: "server" });

    const attached = EventFlow.fromHeaders(headers);
    EventFlow.step("validate-payment");
    const ended = EventFlow.endEvent();

    expect(attached?.id).toBe("evt_client");
    expect(ended?.id).toBe("evt_client");
    expect(ended?.traceId).toBe("trc_shared");
    expect(ended?.context).toEqual({ cartId: "c42", source: "server" });
    expect(ended?.encryptedContext).toEqual({ clientSecret: "pi_secret_123" });
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
    EventFlow.configure({ encryptionKey: "shared-secret" });
    const encryptedHeaders = getPropagationHeaders(
      {
        id: "evt_client",
        name: "checkout",
        status: "success",
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        context: { cartId: "c99" },
        encryptedContext: { clientSecret: "pi_secret_99" },
        steps: [],
        traceId: "trc_shared",
      } as EventLog,
      {
        encryptionKey: "shared-secret",
      },
    );
    const req = {
      method: "POST",
      url: "/checkout",
      headers: {
        ...encryptedHeaders,
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
    expect(memory.events[0].encryptedContext).toMatchObject({
      clientSecret: "pi_secret_99",
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
    EventFlow.configure({ encryptionKey: "shared-secret" });
    EventFlow.startEvent("checkout");
    EventFlow.step("press-pay");
    EventFlow.addContext({ cartId: "c123" });
    EventFlow.addEncryptedContext({ clientSecret: "pi_secret_123" });

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
    expect(ended?.encryptedContext).toEqual({
      clientSecret: "pi_secret_123",
    });
  });

  it("creates and consumes generic metadata for webhook continuation", () => {
    EventFlow.configure({ encryptionKey: "shared-secret" });
    EventFlow.startEvent("checkout");
    EventFlow.addContext({ orderId: "ord_1", userId: 9 });
    EventFlow.addEncryptedContext({ paymentIntentSecret: "secret_pi" });
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
    expect(ended?.encryptedContext).toMatchObject({
      paymentIntentSecret: "secret_pi",
    });
    expect(JSON.stringify(metadata)).not.toContain("secret_pi");
  });

  it("returns null when continuation token is invalid", () => {
    const attached = EventFlow.continueFromToken("{not-json}");
    expect(attached).toBeNull();
  });

  it("throws when encrypted propagation is restored without the shared key", () => {
    EventFlow.configure({ encryptionKey: "shared-secret" });
    EventFlow.startEvent("checkout");
    EventFlow.addEncryptedContext({ clientSecret: "pi_secret_123" });
    const token = EventFlow.getContinuationToken() as string;

    EventFlow.configure({ encryptionKey: undefined });

    expect(() => {
      EventFlow.continueFromToken(token);
    }).toThrow(
      "EventFlow encrypted context requires configure({ encryptionKey }) with the shared key.",
    );
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
