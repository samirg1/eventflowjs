import { EventFlow } from "../src/index.js";

const createPaymentIntent = EventFlow.instrument(
  "createPaymentIntent",
  async (input: { cartId: string; amount: number }) => {
    await sleep(20);
    return {
      paymentId: `pay_${Math.random().toString(36).slice(2, 10)}`,
      clientSecret: `sec_${Math.random().toString(36).slice(2, 10)}`,
      amount: input.amount,
    };
  },
  {
    contextFromArgs: (input) => ({
      cartId: input.cartId,
      amount: input.amount,
    }),
    contextFromResult: (result) => ({
      paymentId: result.paymentId,
    }),
  },
);

const finalizeOrder = EventFlow.instrument(
  "finalizeOrder",
  async (paymentId: string) => {
    await sleep(15);
    return { orderId: `ord_${paymentId.slice(-6)}` };
  },
  {
    contextFromResult: (result) => ({ orderId: result.orderId }),
  },
);

async function runCheckoutFlow(): Promise<void> {
  // Frontend starts checkout
  EventFlow.startEvent("checkout");
  EventFlow.addContext({ cartId: "cart_2005", uiSessionId: "sess_abc" });
  EventFlow.step("press-pay");

  // Frontend -> server request
  const requestHeaders = EventFlow.getPropagationHeaders();
  const serverResponse = await createPaymentIntentOnServer(requestHeaders, {
    cartId: "cart_2005",
    amount: 1299,
  });

  // Frontend continues using server continuation token
  EventFlow.continueFromToken(serverResponse.continuationToken);
  EventFlow.step("show-payment-sheet");
  EventFlow.addContext({ paymentId: serverResponse.paymentId });
  EventFlow.step("confirm-payment");
  EventFlow.endEvent();

  // Later, provider webhook continues the same event by metadata
  await handleProviderWebhook({
    type: "payment.succeeded",
    data: {
      paymentId: serverResponse.paymentId,
      metadata: serverResponse.providerMetadata,
    },
  });
}

async function createPaymentIntentOnServer(
  headers: Record<string, string>,
  input: { cartId: string; amount: number },
): Promise<{
  paymentId: string;
  continuationToken: string;
  providerMetadata: Record<string, string>;
}> {
  const attached = EventFlow.fromHeaders(headers);
  if (!attached) {
    EventFlow.startEvent("checkout-api");
  }

  const paymentIntent = await EventFlow.run("create-intent", async () => {
    return createPaymentIntent(input);
  });

  EventFlow.step("respond-with-client-secret");

  const continuationToken = EventFlow.getContinuationToken();
  const providerMetadata = EventFlow.getPropagationMetadata();

  EventFlow.endEvent();

  return {
    paymentId: paymentIntent.paymentId,
    continuationToken: continuationToken ?? "",
    providerMetadata,
  };
}

async function handleProviderWebhook(payload: {
  type: string;
  data: {
    paymentId: string;
    metadata: Record<string, string>;
  };
}): Promise<void> {
  const attached = EventFlow.fromMetadata(payload.data.metadata);
  if (!attached) {
    EventFlow.startEvent("provider-webhook");
  }

  await EventFlow.run("verify-webhook", async () => {
    await sleep(5);
  });

  await EventFlow.run("mark-payment-succeeded", async () => {
    EventFlow.addContext({
      providerEventType: payload.type,
      paymentId: payload.data.paymentId,
    });
  });

  await finalizeOrder(payload.data.paymentId);
  EventFlow.endEvent();
}

void runCheckoutFlow();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
