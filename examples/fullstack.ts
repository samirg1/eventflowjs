import { EventFlow } from "../src/index.js";

EventFlow.startEvent("checkout");
EventFlow.step("press-pay");
EventFlow.addContext({ cartId: "cart_1001" });

const requestHeaders = EventFlow.getPropagationHeaders();
const serverResult = createPaymentIntentOnServer(requestHeaders);

EventFlow.continueFromToken(serverResult.continuationToken);
EventFlow.addContext({ paymentId: serverResult.paymentId });
EventFlow.step("show-payment-sheet");
EventFlow.step("process-payment");
EventFlow.endEvent();

function createPaymentIntentOnServer(headers: Record<string, string>): {
  paymentId: string;
  continuationToken: string;
} {
  const continued = EventFlow.fromHeaders(headers);

  if (!continued) {
    EventFlow.startEvent("checkout-server");
  }

  EventFlow.step("create-payment-intent");
  const paymentId = `pi_${Math.random().toString(36).slice(2, 8)}`;
  EventFlow.addContext({ paymentId });

  const continuationToken = EventFlow.getContinuationToken() ?? "";

  // Server request lifecycle finished; event is emitted on the server here.
  EventFlow.endEvent();

  return {
    paymentId,
    continuationToken,
  };
}
