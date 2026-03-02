import http from "node:http";
import {
  EventFlow,
  createEventFlowMiddleware,
  type EventContext,
  type EventLog,
  type HeadersLike,
  type Transport,
} from "../src/index.js";

class RedactingConsoleTransport implements Transport {
  log(event: EventLog): void {
    const sanitized = {
      ...event,
      context: redactContext(event.context),
    };

    console.log(JSON.stringify(sanitized));
  }
}

EventFlow.setTransport(new RedactingConsoleTransport());

const createUser = EventFlow.instrument(
  "createUser",
  async (input: { email: string; name: string }) => {
    await sleep(25);

    if (input.email.endsWith("@blocked.example")) {
      throw new Error("email-domain-blocked");
    }

    return {
      id: `usr_${Math.random().toString(36).slice(2, 9)}`,
      email: input.email,
      name: input.name,
      createdAt: new Date().toISOString(),
    };
  },
  {
    contextFromArgs: (input) => ({
      emailDomain: input.email.split("@")[1],
      userNameLength: input.name.length,
    }),
    contextFromResult: (result) => ({
      createdUserId: result.id,
    }),
  },
);

const eventFlowMiddleware = createEventFlowMiddleware(EventFlow, {
  eventName: (req) => `http:${req.method ?? "GET"} ${stripQuery(req.url)}`,
  mapContext: (req) => ({
    requestId: firstHeader(req.headers, "x-request-id") ?? randomRequestId(),
    tenantId: firstHeader(req.headers, "x-tenant-id") ?? "public",
    userAgent: firstHeader(req.headers, "user-agent"),
  }),
  includeRequestContext: true,
  failOn5xx: true,
});

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/users") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  eventFlowMiddleware(req, res, () => {
    void handleCreateUser(req, res);
  });
});

server.on("error", (error) => {
  console.error("Cannot bind port in this environment:", error);
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    return;
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const success = await fetch(`${baseUrl}/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_demo_success",
      "x-tenant-id": "acme",
    },
    body: JSON.stringify({ email: "jane@acme.dev", name: "Jane" }),
  });

  console.log("Success response:", await success.text());

  const failure = await fetch(`${baseUrl}/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_demo_failure",
      "x-tenant-id": "acme",
    },
    body: JSON.stringify({ email: "bad@blocked.example", name: "Blocked" }),
  });

  console.log("Failure response:", await failure.text());

  server.close();
});

async function handleCreateUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const payload = await EventFlow.run("parse-json", async () => {
      return parseJsonBody(req) as Promise<{ email: string; name: string }>;
    });

    await EventFlow.run("validate-input", async () => {
      if (!payload.email || !payload.name) {
        const error = new Error("invalid-input");
        (error as Error & { statusCode?: number }).statusCode = 400;
        throw error;
      }
    });

    const user = await createUser(payload);

    EventFlow.step("respond-201");
    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user }));
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;

    EventFlow.addContext({
      responseError: err.message,
      responseStatusCode: statusCode,
    });

    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("invalid-json");
        (error as Error & { statusCode?: number }).statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function firstHeader(
  headers: HeadersLike,
  name: string,
): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return value ?? undefined;
  }

  const value = (headers as Record<string, string | string[] | undefined>)[name];

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0];
  }

  return undefined;
}

function stripQuery(url: string | undefined): string {
  if (!url) {
    return "/";
  }

  const [path] = url.split("?");
  return path || "/";
}

function randomRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function redactContext(context: EventContext): EventContext {
  const sanitized: EventContext = {};

  for (const [key, value] of Object.entries(context)) {
    if (key.toLowerCase().includes("email") && typeof value === "string") {
      const domain = value.includes("@") ? value.split("@")[1] : "redacted";
      sanitized[key] = `***@${domain}`;
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
