import type { EventContext, HeadersLike } from "../types.js";

export interface NodeLikeRequest {
  headers: HeadersLike;
  method?: string;
  url?: string;
}

export interface NodeLikeResponse {
  statusCode?: number;
  on(event: "finish" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export type NextFunction = (error?: unknown) => void;

export type EventFlowMiddleware = (
  req: NodeLikeRequest,
  res: NodeLikeResponse,
  next: NextFunction,
) => void;

export interface EventFlowMiddlewareOptions {
  eventName?: string | ((req: NodeLikeRequest) => string);
  mapContext?: (req: NodeLikeRequest) => EventContext;
  includeRequestContext?: boolean;
  failOn5xx?: boolean;
  autoEnd?: boolean;
}

export interface EventFlowLike {
  startEvent(name: string): unknown;
  addContext(data: EventContext): void;
  endEvent(status?: "success" | "failed" | "cancelled"): unknown;
  fail(error: unknown): unknown;
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
