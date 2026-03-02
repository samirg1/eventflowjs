import http from "node:http";
import { EventFlow, eventFlowMiddleware } from "../src/index.js";

const server = http.createServer((req, res) => {
  if (req.url !== "/checkout" || req.method !== "POST") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  eventFlowMiddleware(req, res, () => {
    EventFlow.step("validate-payment");
    EventFlow.addContext({ userId: 42, source: "server" });

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
});

server.on("error", (error) => {
  console.error("Server example cannot bind a local port in this environment:", error);
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    return;
  }

  const port = address.port;

  EventFlow.startEvent("checkout");
  EventFlow.addContext({ cartId: "cart_demo" });
  const headers = EventFlow.getPropagationHeaders();

  await fetch(`http://127.0.0.1:${port}/checkout`, {
    method: "POST",
    headers,
  });

  EventFlow.step("request-sent");
  EventFlow.endEvent();

  server.close();
});

/*
Express usage:

import express from "express";
import { eventFlowMiddleware } from "eventflowjs";

const app = express();
app.use(eventFlowMiddleware);

app.post("/checkout", (_req, res) => {
  EventFlow.step("validate-payment");
  EventFlow.addContext({ userId: 42 });
  res.json({ ok: true });
});
*/
