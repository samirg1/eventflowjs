import { EventFlow } from "../src/index.js";

// Step 1: API server receives checkout request and creates provider metadata.
EventFlow.startEvent("checkout");
EventFlow.step("create-payment-intent");
EventFlow.addContext({ orderId: "ord_2002", userId: 42 });

const providerMetadata = EventFlow.getPropagationMetadata();

// In a real integration, pass this metadata to any provider that supports metadata fields.

EventFlow.endEvent();

// Step 2: Later, provider webhook arrives with that metadata.
handleProviderWebhook({
  type: "payment.succeeded",
  data: {
    object: {
      id: "pay_demo_123",
      metadata: providerMetadata,
    },
  },
});

function handleProviderWebhook(payload: {
  type: string;
  data: { object: { id: string; metadata: Record<string, string> } };
}): void {
  const attached = EventFlow.fromMetadata(payload.data.object.metadata);

  if (!attached) {
    EventFlow.startEvent("provider-webhook");
  }

  EventFlow.step("webhook-received");
  EventFlow.addContext({
    providerEventType: payload.type,
    providerObjectId: payload.data.object.id,
  });
  EventFlow.endEvent();
}
