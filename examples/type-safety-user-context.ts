import { EventFlow, type EventFlowClient } from "../src/index.js";

type Account = {
  uid: string;
  email: string;
};

const account: Account = {
  uid: "u_1",
  email: "typed@example.com",
};

const TypedEventFlow: EventFlowClient<never> = EventFlow;

// @ts-expect-error addUserContext is unavailable until getUserContext is configured.
TypedEventFlow.addUserContext(account);

TypedEventFlow.configure({
  getUserContext: (configuredAccount: Account) => ({
    id: configuredAccount.uid,
    email: configuredAccount.email,
  }),
});

TypedEventFlow.addUserContext(account);

// @ts-expect-error Account.email is required.
TypedEventFlow.addUserContext({ uid: "u_2" });

// @ts-expect-error Account.uid must be a string.
TypedEventFlow.addUserContext({ uid: 42, email: "wrong@example.com" });
