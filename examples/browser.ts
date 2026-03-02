import { EventFlow } from "../src/index.js";

EventFlow.startEvent("checkout");
EventFlow.addContext({ cartId: "cart_123" });
EventFlow.step("prepare-request");

const headers = EventFlow.getPropagationHeaders();

console.log("Propagation headers for browser->server requests:");
console.log(headers);

console.log(`
Use with fetch in the browser:

await fetch("/api/checkout", {
  method: "POST",
  headers: EventFlow.getPropagationHeaders()
});
`);

EventFlow.endEvent("cancelled");
