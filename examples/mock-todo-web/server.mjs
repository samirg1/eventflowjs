import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  ConsoleTransport,
  EventFlow,
  createEventFlowMiddleware,
} from "../../dist/src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const publicDir = path.join(__dirname, "public");
const distDir = path.join(projectRoot, "dist", "src");

if (!fs.existsSync(path.join(distDir, "index.js"))) {
  console.error("Build artifacts not found. Run `npm run build` first.");
  process.exit(1);
}

const todos = [];
let nextTodoId = 1;

const emittedServerEvents = [];
const sseClients = new Set();

const debugTransport = {
  log(event) {
    const item = {
      ...event,
      source: "server",
      emitted_at: new Date().toISOString(),
    };

    emittedServerEvents.unshift(item);
    if (emittedServerEvents.length > 200) {
      emittedServerEvents.pop();
    }

    const payload = JSON.stringify(item);
    for (const client of sseClients) {
      client.write(`data: ${payload}\n\n`);
    }
  },
};

EventFlow.setTransport([new ConsoleTransport(), debugTransport]);

const eventFlowMiddleware = createEventFlowMiddleware(EventFlow, {
  eventName: (req) => `api:${req.method ?? "GET"} ${pathname(req.url)}`,
  mapContext: (req) => ({
    app: "mock-todo-web",
    requestId: firstHeader(req.headers, "x-request-id") ?? randomRequestId(),
  }),
  includeRequestContext: true,
  failOn5xx: true,
  autoEnd: true,
});

const server = http.createServer((req, res) => {
  const routePath = pathname(req.url);

  if (routePath.startsWith("/api/")) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
  }

  if (routePath === "/api/debug/stream") {
    handleSse(req, res);
    return;
  }

  if (routePath === "/api/debug/events") {
    sendJson(res, 200, {
      events: emittedServerEvents.slice(0, 100),
    });
    return;
  }

  if (routePath === "/api/webhook/todo-sync" && req.method === "POST") {
    void handleWebhook(req, res);
    return;
  }

  if (routePath.startsWith("/api/")) {
    eventFlowMiddleware(req, res, () => {
      void handleApi(req, res).catch((error) => {
        const err = toError(error);
        const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
        EventFlow.addContext({
          unhandledError: err.message,
          responseStatusCode: statusCode,
        });
        sendJson(res, statusCode, { error: err.message });
      });
    });
    return;
  }

  serveStatic(routePath, res);
});

server.on("error", (error) => {
  console.error("Mock web server failed to start:", error);
});

server.listen(4310, "127.0.0.1", () => {
  console.log("Mock todo app running at http://127.0.0.1:4310");
});

async function handleApi(req, res) {
  const routePath = pathname(req.url);

  if (routePath === "/api/todos" && req.method === "GET") {
    await EventFlow.run("load-todos", async () => {
      EventFlow.addContext({ totalTodos: todos.length });
    });

    return respondWithContinuation(res, 200, { todos });
  }

  if (routePath === "/api/todos" && req.method === "POST") {
    const payload = await EventFlow.run(
      "parse-create-body",
      async () => readJson(req),
      { failEventOnError: false },
    );

    await EventFlow.run(
      "validate-create-body",
      async () => {
        if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
          const error = new Error("text-required");
          error.statusCode = 400;
          throw error;
        }
      },
      { failEventOnError: false },
    );

    const todo = await EventFlow.run("create-todo", async () => {
      const item = {
        id: String(nextTodoId++),
        text: payload.text.trim(),
        done: false,
        createdAt: new Date().toISOString(),
      };
      todos.unshift(item);
      EventFlow.addContext({ createdTodoId: item.id });
      return item;
    });

    return respondWithContinuation(res, 201, { todo });
  }

  if (routePath.startsWith("/api/todos/") && routePath.endsWith("/toggle") && req.method === "PATCH") {
    const todoId = routePath.split("/")[3] ?? "";

    const todo = await EventFlow.run(
      "toggle-todo",
      async () => {
        const found = todos.find((item) => item.id === todoId);
        if (!found) {
          const error = new Error("todo-not-found");
          error.statusCode = 404;
          throw error;
        }

        found.done = !found.done;
        EventFlow.addContext({ toggledTodoId: found.id, done: found.done });
        return found;
      },
      { failEventOnError: false },
    );

    return respondWithContinuation(res, 200, { todo });
  }

  if (routePath.startsWith("/api/todos/") && req.method === "DELETE") {
    const todoId = routePath.split("/")[3] ?? "";

    await EventFlow.run(
      "delete-todo",
      async () => {
        const index = todos.findIndex((item) => item.id === todoId);
        if (index < 0) {
          const error = new Error("todo-not-found");
          error.statusCode = 404;
          throw error;
        }

        const [removed] = todos.splice(index, 1);
        EventFlow.addContext({ deletedTodoId: removed.id });
      },
      { failEventOnError: false },
    );

    return respondWithContinuation(res, 200, { ok: true });
  }

  res.statusCode = 404;
  sendJson(res, 404, { error: "not_found" });
}

async function handleWebhook(req, res) {
  try {
    const body = await readJson(req);
    const attached = EventFlow.fromMetadata(body.metadata ?? {});

    if (!attached) {
      EventFlow.startEvent("webhook:todo-sync");
    }

    await EventFlow.run("process-webhook", async () => {
      EventFlow.addContext({
        webhookAction: body.action ?? "unknown",
        webhookSource: "mock-provider",
      });
    });

    const continuationToken = EventFlow.getContinuationToken();
    EventFlow.endEvent();

    sendJson(res, 200, {
      ok: true,
      continuationToken,
    });
  } catch (error) {
    EventFlow.fail(error);
    sendJson(res, 400, {
      error: toError(error).message,
    });
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
}

function serveStatic(routePath, res) {
  if (routePath.startsWith("/eventflow/")) {
    const relative = routePath.replace(/^\/eventflow\//, "");
    const filePath = path.join(distDir, relative);
    return sendFile(filePath, res);
  }

  const filePath =
    routePath === "/"
      ? path.join(publicDir, "index.html")
      : path.join(publicDir, routePath.replace(/^\//, ""));

  sendFile(filePath, res);
}

function sendFile(filePath, res) {
  const normalized = path.normalize(filePath);
  if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const ext = path.extname(normalized);
  const mime =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "text/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";

  res.setHeader("content-type", mime);
  fs.createReadStream(normalized).pipe(res);
}

function respondWithContinuation(res, statusCode, payload) {
  const continuationToken = EventFlow.getContinuationToken();
  if (continuationToken) {
    res.setHeader("x-eventflow-token", continuationToken);
  }

  sendJson(res, statusCode, {
    ...payload,
    continuationToken,
  });
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "content-type",
      "x-request-id",
      "x-eventflow-trace-id",
      "x-eventflow-event-id",
      "x-eventflow-context",
      "x-eventflow-event",
    ].join(","),
  );
}

function firstHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0];
  }

  return undefined;
}

function pathname(rawUrl) {
  return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
}

function randomRequestId() {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function toError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error("invalid-json");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
