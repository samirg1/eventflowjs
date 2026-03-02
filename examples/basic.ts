import { EventFlow } from "../src/index.js";

EventFlow.startEvent("createUser");
EventFlow.addContext({
  userId: 123,
  email: "test@example.com",
});
EventFlow.step("create-db-record");
EventFlow.step("send-email");
EventFlow.endEvent();
