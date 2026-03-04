import type { EventContext, HeadersLike } from "../types.js";

/**
 * Minimal request shape consumed by `createEventFlowMiddleware`.
 */
export interface NodeLikeRequest {
  /**
   * Incoming headers used for propagation extraction.
   */
  headers: HeadersLike;
  /**
   * HTTP method when available.
   */
  method?: string;
  /**
   * Request URL/path when available.
   */
  url?: string;
}

/**
 * Minimal response shape required by the middleware.
 */
export interface NodeLikeResponse {
  /**
   * Final response status code.
   */
  statusCode?: number;
  /**
   * Registers completion listeners.
   */
  on(event: "finish" | "close", listener: () => void): unknown;
  /**
   * Registers response error listener.
   */
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Express-style `next` callback.
 */
export type NextFunction = (error?: unknown) => void;

/**
 * Middleware function signature returned by `createEventFlowMiddleware`.
 */
export type EventFlowMiddleware = (
  req: NodeLikeRequest,
  res: NodeLikeResponse,
  next: NextFunction,
) => void;

/**
 * Runtime behavior options for the node middleware adapter.
 *
 * @example
 * ```ts
 * createEventFlowMiddleware(client, {
 *   eventName: (req) => `http:${req.method} ${req.url}`,
 *   includeRequestContext: true,
 *   failOn5xx: true,
 * });
 * ```
 */
export interface EventFlowMiddlewareOptions {
  /**
   * Static or computed event name for newly started request events.
   *
   * @default `http:${method} ${url}` fallback
   */
  eventName?: string | ((req: NodeLikeRequest) => string);
  /**
   * Optional request-to-context mapper executed before calling `next()`.
   */
  mapContext?: (req: NodeLikeRequest) => EventContext;
  /**
   * Include `method` and `url` fields in event context.
   *
   * @default true
   */
  includeRequestContext?: boolean;
  /**
   * Mark response status codes >= 500 as failed events.
   *
   * @default true
   */
  failOn5xx?: boolean;
  /**
   * Automatically end the event on `finish`/`close`.
   *
   * @default true
   */
  autoEnd?: boolean;
}

/**
 * Minimal EventFlow client contract required by the middleware.
 */
export interface EventFlowLike {
  /**
   * Starts a new event.
   */
  startEvent(name: string): unknown;
  /**
   * Adds request context to the active event.
   */
  addContext(data: EventContext): void;
  /**
   * Ends the active event with an optional status.
   */
  endEvent(status?: "success" | "failed" | "cancelled"): unknown;
  /**
   * Fails the active event with error details.
   */
  fail(error: unknown): unknown;
  /**
   * Attempts to continue an event from request headers.
   */
  fromHeaders(headers: HeadersLike): unknown;
}

export function createEventFlowMiddleware(
  client: EventFlowLike,
  options: EventFlowMiddlewareOptions = {},
): EventFlowMiddleware {
  const {
    eventName,
    mapContext,
    includeRequestContext = true,
    failOn5xx = true,
    autoEnd = true,
  } = options;

  return (req, res, next) => {
    const propagated = client.fromHeaders(req.headers);
    if (!propagated) {
      client.startEvent(resolveEventName(eventName, req));
    }

    if (includeRequestContext) {
      client.addContext({
        method: req.method,
        url: req.url,
      });
    }

    if (mapContext) {
      client.addContext(mapContext(req));
    }

    let settled = false;

    const finalize = (type: "finish" | "close" | "error", error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;

      if (type === "error") {
        client.fail(error ?? new Error("Unhandled response error"));
        return;
      }

      if (!autoEnd) {
        return;
      }

      const statusCode = res.statusCode ?? 200;
      if (failOn5xx && statusCode >= 500) {
        client.endEvent("failed");
        return;
      }

      client.endEvent("success");
    };

    res.on("finish", () => finalize("finish"));
    res.on("close", () => finalize("close"));
    res.on("error", (error) => finalize("error", error));

    try {
      next();
    } catch (error) {
      finalize("error", error);
      throw error;
    }
  };
}

function resolveEventName(
  eventName: EventFlowMiddlewareOptions["eventName"],
  req: NodeLikeRequest,
): string {
  if (typeof eventName === "function") {
    return eventName(req);
  }

  if (typeof eventName === "string") {
    return eventName;
  }

  const method = req.method ?? "REQUEST";
  const url = req.url ?? "/";
  return `http:${method} ${url}`;
}
