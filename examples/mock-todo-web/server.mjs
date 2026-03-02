import { ConsoleTransport, EventFlowClient } from "../../dist/src/react-native.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

function createContextManager() {
  let currentEvent = null;
  let traceId = null;

  return {
    getCurrentEvent() {
      return currentEvent;
    },
    setCurrentEvent(event) {
      currentEvent = event;
    },
    getTraceId() {
      return traceId;
    },
    setTraceId(nextTraceId) {
      traceId = nextTraceId;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function parsePath(rawUrl) {
  return new URL(rawUrl ?? "/", "https://mock.local").pathname;
}

function firstHeader(headers, name) {
  if (!headers) {
    return undefined;
  }

  const direct = headers[name];
  if (typeof direct === "string") {
    return direct;
  }

  const lower = headers[name.toLowerCase()];
  if (typeof lower === "string") {
    return lower;
  }

  return undefined;
}

function randomRequestId() {
  return `mock_${Math.random().toString(36).slice(2, 10)}`;
}

export function createMockServer(options = {}) {
  const {
    seedTodos = [
      { id: "1", text: "Try creating a todo", done: false, createdAt: new Date().toISOString() },
      { id: "2", text: "Toggle a todo to emit steps", done: true, createdAt: new Date().toISOString() },
    ],
    baseLatencyMs = 80,
  } = options;

  const todos = seedTodos.map((item) => ({ ...item }));
  let nextTodoId = Math.max(0, ...todos.map((item) => Number.parseInt(item.id, 10) || 0)) + 1;

  const emittedEvents = [];
  const serverFlow = new EventFlowClient(createContextManager());

  const captureTransport = {
    log(event) {
      emittedEvents.unshift({
        ...event,
        source: "server",
        emitted_at: new Date().toISOString(),
      });

      if (emittedEvents.length > 200) {
        emittedEvents.pop();
      }
    },
  };

  serverFlow.setTransport([new ConsoleTransport(), captureTransport]);

  const createTodo = serverFlow.instrument(
    "server.todo.create",
    async (body) => {
      await sleep(baseLatencyMs + 30);

      const text = String(body?.text ?? "").trim();
      if (!text) {
        throw new Error("text-required");
      }

      const todo = {
        id: String(nextTodoId++),
        text,
        done: false,
        createdAt: new Date().toISOString(),
      };

      todos.unshift(todo);
      return todo;
    },
    {
      stepName: "db:insert-todo",
      startIfMissing: false,
      contextFromArgs: (body) => ({ requestedTextLength: String(body?.text ?? "").length }),
      contextFromResult: (todo) => ({ createdTodoId: todo.id }),
    },
  );

  const processWebhook = serverFlow.instrument(
    "server.webhook.process",
    async (body) => {
      await sleep(baseLatencyMs + 50);
      return {
        ok: true,
        action: body?.action ?? "unknown",
      };
    },
    {
      stepName: "webhook:process",
      startIfMissing: false,
      contextFromArgs: (body) => ({ webhookAction: body?.action ?? "unknown" }),
    },
  );

  async function routeRequest(method, path, body) {
    if (method === "GET" && path === "/api/debug/events") {
      return {
        status: 200,
        body: {
          events: emittedEvents.slice(0, 100),
        },
      };
    }

    if (method === "GET" && path === "/api/todos") {
      const items = await serverFlow.run(
        "db:list-todos",
        async () => {
          await sleep(baseLatencyMs);
          return todos.map((item) => ({ ...item }));
        },
        { startIfMissing: false },
      );

      serverFlow.addContext({ totalTodos: items.length });
      return {
        status: 200,
        body: { todos: items },
      };
    }

    if (method === "POST" && path === "/api/todos") {
      const todo = await createTodo(body);
      return {
        status: 201,
        body: { todo },
      };
    }

    if (method === "PATCH" && /^\/api\/todos\/[^/]+\/toggle$/.test(path)) {
      const id = path.split("/")[3];

      const todo = await serverFlow.run(
        "db:toggle-todo",
        async () => {
          await sleep(baseLatencyMs + 10);

          const found = todos.find((item) => item.id === id);
          if (!found) {
            throw new Error("todo-not-found");
          }

          found.done = !found.done;
          return { ...found };
        },
        { startIfMissing: false },
      );

      serverFlow.addContext({ toggledTodoId: todo.id, done: todo.done });
      return {
        status: 200,
        body: { todo },
      };
    }

    if (method === "DELETE" && /^\/api\/todos\/[^/]+$/.test(path)) {
      const id = path.split("/")[3];

      await serverFlow.run(
        "db:delete-todo",
        async () => {
          await sleep(baseLatencyMs + 20);

          const index = todos.findIndex((item) => item.id === id);
          if (index < 0) {
            throw new Error("todo-not-found");
          }

          const [removed] = todos.splice(index, 1);
          serverFlow.addContext({ deletedTodoId: removed.id });
        },
        { startIfMissing: false },
      );

      return {
        status: 200,
        body: { ok: true },
      };
    }

    if (method === "POST" && path === "/api/checkout") {
      const paymentIntent = await serverFlow.run(
        "checkout:create-payment-intent",
        async () => {
          await sleep(baseLatencyMs + 35);
          return `pi_${Math.random().toString(36).slice(2, 10)}`;
        },
        { startIfMissing: false },
      );

      serverFlow.addContext({ paymentIntent });
      return {
        status: 200,
        body: {
          ok: true,
          paymentIntent,
        },
      };
    }

    if (method === "POST" && path === "/api/webhook/todo-sync") {
      if (!serverFlow.fromMetadata(body?.metadata ?? {})) {
        serverFlow.startEvent("webhook.todo-sync");
      }

      serverFlow.addContext({
        surface: "server",
        requestKind: "webhook",
      });

      const result = await processWebhook(body);
      const continuationToken = serverFlow.getContinuationToken();
      serverFlow.endEvent();

      return {
        status: 200,
        headers: continuationToken
          ? { "x-eventflow-token": continuationToken }
          : undefined,
        body: {
          ...result,
          continuationToken,
        },
      };
    }

    return {
      status: 404,
      body: { error: "not_found" },
    };
  }

  async function request(input = {}) {
    const method = String(input.method ?? "GET").toUpperCase();
    const path = parsePath(input.url ?? input.path ?? "/");
    const headers = input.headers ?? {};
    const body = input.body ?? {};

    if (method === "OPTIONS" && path.startsWith("/api/")) {
      return {
        status: 204,
        headers: {
          ...JSON_HEADERS,
          "access-control-allow-origin": "*",
        },
        body: {},
      };
    }

    if (!path.startsWith("/api/")) {
      return {
        status: 404,
        headers: { ...JSON_HEADERS },
        body: { error: "not_found" },
      };
    }

    if (path !== "/api/webhook/todo-sync") {
      serverFlow.fromHeaders(headers);
      if (!serverFlow.getCurrentEvent()) {
        serverFlow.startEvent(`api:${method} ${path}`);
      }
    }

    serverFlow.addContext({
      surface: "server",
      requestPath: path,
      requestMethod: method,
      requestId: firstHeader(headers, "x-request-id") ?? randomRequestId(),
      transport: "mock-server",
    });

    serverFlow.step("request:received");

    try {
      const routed = await routeRequest(method, path, body);
      const continuationToken = serverFlow.getContinuationToken();

      if (path !== "/api/webhook/todo-sync") {
        serverFlow.addContext({ responseStatusCode: routed.status });
        serverFlow.endEvent(routed.status >= 400 ? "failed" : "success");
      }

      return {
        status: routed.status,
        headers: {
          ...JSON_HEADERS,
          ...(routed.headers ?? {}),
          ...(continuationToken ? { "x-eventflow-token": continuationToken } : {}),
        },
        body: {
          ...(routed.body ?? {}),
          ...(continuationToken ? { continuationToken } : {}),
        },
      };
    } catch (error) {
      const err = toError(error);
      serverFlow.fail(err);

      const status = err.message === "todo-not-found" ? 404 : 400;
      return {
        status,
        headers: { ...JSON_HEADERS },
        body: { error: err.message },
      };
    }
  }

  return {
    request,
    getEmittedEvents() {
      return emittedEvents.slice(0, 100);
    },
    reset() {
      todos.splice(0, todos.length, ...seedTodos.map((item) => ({ ...item })));
      emittedEvents.splice(0, emittedEvents.length);
      nextTodoId = Math.max(0, ...todos.map((item) => Number.parseInt(item.id, 10) || 0)) + 1;
    },
  };
}

export default createMockServer;
