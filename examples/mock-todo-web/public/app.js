import { ConsoleTransport, EventFlow } from "../../../dist/src/react-native.js";
import { createMockServer } from "../server.mjs";

const server = createMockServer();

const elements = {
  todoForm: document.querySelector("#todo-form"),
  todoInput: document.querySelector("#todo-input"),
  todoList: document.querySelector("#todo-list"),
  simulateWebhookButton: document.querySelector("#simulate-webhook"),
  simulateCheckoutButton: document.querySelector("#simulate-checkout"),
  simulateFailureButton: document.querySelector("#simulate-failure"),
  resetDemoButton: document.querySelector("#reset-demo"),
  clientActiveEl: document.querySelector("#client-active"),
  clientEmittedEl: document.querySelector("#client-emitted"),
  serverEmittedEl: document.querySelector("#server-emitted"),
  statusEl: document.querySelector("#status"),
};

const state = {
  todos: [],
  clientEvents: [],
  serverEvents: [],
};

const captureTransport = {
  log(event) {
    state.clientEvents.unshift({
      ...event,
      source: "client",
      emitted_at: new Date().toISOString(),
    });

    if (state.clientEvents.length > 100) {
      state.clientEvents.pop();
    }

    renderDebug();
  },
};

EventFlow.setTransport([new ConsoleTransport(), captureTransport]);

const saveDraftInstrumentation = EventFlow.instrument(
  "client.todo.draft",
  async (value) => {
    await sleep(20);
    return { chars: value.length };
  },
  {
    stepName: "ui:autosave-draft",
    contextFromArgs: (value) => ({ draftLength: value.length }),
    contextFromResult: (result) => ({ autosavedChars: result.chars }),
    startIfMissing: true,
    eventName: "client.todo.input",
  },
);

void loadTodos();
setInterval(syncServerEvents, 250);
setInterval(renderDebug, 250);

if (elements.todoInput) {
  elements.todoInput.addEventListener("input", () => {
    const text = elements.todoInput?.value ?? "";
    if (text.length > 2) {
      void saveDraftInstrumentation(text).catch(() => {
        // No-op; this demo path intentionally ignores draft save errors.
      });
    }
  });
}

if (elements.todoForm) {
  elements.todoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createTodo();
  });
}

if (elements.simulateWebhookButton) {
  elements.simulateWebhookButton.addEventListener("click", () => {
    void simulateWebhookRoundTrip();
  });
}

if (elements.simulateCheckoutButton) {
  elements.simulateCheckoutButton.addEventListener("click", () => {
    void simulateCheckoutFlow();
  });
}

if (elements.simulateFailureButton) {
  elements.simulateFailureButton.addEventListener("click", () => {
    void simulateFailureFlow();
  });
}

if (elements.resetDemoButton) {
  elements.resetDemoButton.addEventListener("click", () => {
    server.reset();
    state.clientEvents = [];
    state.serverEvents = [];
    setStatus("Demo reset");
    void loadTodos();
  });
}

async function loadTodos() {
  try {
    const data = await requestWithEvent({
      eventName: "todo.load",
      method: "GET",
      path: "/api/todos",
      context: { action: "load" },
    });

    state.todos = data.todos ?? [];
    renderTodos();
    setStatus(`Loaded ${state.todos.length} todos`);
  } catch (error) {
    setStatus(`Load failed: ${toError(error).message}`, true);
  }
}

async function createTodo() {
  const text = elements.todoInput?.value?.trim() ?? "";
  if (!text) {
    return;
  }

  try {
    const data = await requestWithEvent({
      eventName: "todo.create",
      method: "POST",
      path: "/api/todos",
      body: { text },
      context: {
        action: "create",
        textLength: text.length,
      },
    });

    if (data.todo) {
      state.todos.unshift(data.todo);
      renderTodos();
    }

    if (elements.todoInput) {
      elements.todoInput.value = "";
    }

    setStatus(`Created todo \"${text}\"`);
  } catch (error) {
    setStatus(`Create failed: ${toError(error).message}`, true);
  }
}

async function toggleTodo(id) {
  try {
    const data = await requestWithEvent({
      eventName: "todo.toggle",
      method: "PATCH",
      path: `/api/todos/${id}/toggle`,
      context: {
        action: "toggle",
        todoId: id,
      },
    });

    if (data.todo) {
      state.todos = state.todos.map((item) => (item.id === data.todo.id ? data.todo : item));
      renderTodos();
    }

    setStatus(`Toggled todo #${id}`);
  } catch (error) {
    setStatus(`Toggle failed: ${toError(error).message}`, true);
  }
}

async function deleteTodo(id) {
  try {
    await requestWithEvent({
      eventName: "todo.delete",
      method: "DELETE",
      path: `/api/todos/${id}`,
      context: {
        action: "delete",
        todoId: id,
      },
    });

    state.todos = state.todos.filter((item) => item.id !== id);
    renderTodos();
    setStatus(`Deleted todo #${id}`);
  } catch (error) {
    setStatus(`Delete failed: ${toError(error).message}`, true);
  }
}

async function simulateCheckoutFlow() {
  EventFlow.startEvent("checkout.orchestration");
  EventFlow.addContext({
    surface: "client",
    cartId: `cart_${Math.random().toString(36).slice(2, 8)}`,
    itemCount: state.todos.length,
  });

  try {
    EventFlow.step("checkout:start");

    const checkoutResponse = await requestAgainstExistingEvent({
      method: "POST",
      path: "/api/checkout",
      body: { amount: 4200, currency: "usd" },
      context: { phase: "create-payment-intent" },
    });

    EventFlow.step("checkout:open-payment-sheet");
    await sleep(90);

    const metadata = EventFlow.getPropagationMetadata();

    const webhookResponse = await mockFetch("/api/webhook/todo-sync", {
      method: "POST",
      body: {
        action: "payment_confirmed",
        metadata,
      },
    });

    if (webhookResponse.data.continuationToken) {
      EventFlow.continueFromToken(webhookResponse.data.continuationToken);
      EventFlow.step("checkout:continued-from-webhook");
    }

    EventFlow.addContext({ paymentIntent: checkoutResponse.data.paymentIntent });
    EventFlow.step("checkout:complete");
    EventFlow.endEvent();
    setStatus("Checkout flow simulated");
  } catch (error) {
    EventFlow.fail(error);
    setStatus(`Checkout simulation failed: ${toError(error).message}`, true);
  }
}

async function simulateWebhookRoundTrip() {
  EventFlow.startEvent("todo.webhookRoundTrip");
  EventFlow.addContext({
    surface: "client",
    source: "simulate-webhook-button",
  });

  try {
    EventFlow.step("webhook:prepare-metadata");
    const metadata = EventFlow.getPropagationMetadata();

    const response = await mockFetch("/api/webhook/todo-sync", {
      method: "POST",
      body: {
        action: "todo_synced",
        metadata,
      },
    });

    if (response.data.continuationToken) {
      EventFlow.continueFromToken(response.data.continuationToken);
      EventFlow.step("webhook:continued-on-client");
    }

    EventFlow.endEvent();
    setStatus("Webhook metadata continuation simulated");
  } catch (error) {
    EventFlow.fail(error);
    setStatus(`Webhook simulation failed: ${toError(error).message}`, true);
  }
}

async function simulateFailureFlow() {
  try {
    await requestWithEvent({
      eventName: "todo.forceFailure",
      method: "PATCH",
      path: "/api/todos/999999/toggle",
      context: {
        action: "forced-failure",
      },
    });
  } catch {
    setStatus("Failure flow emitted expected failed events", true);
  }
}

async function requestWithEvent({ eventName, method, path, body, context = {} }) {
  EventFlow.startEvent(eventName);
  EventFlow.addContext({
    surface: "client",
    ...context,
  });

  try {
    const response = await requestAgainstExistingEvent({
      method,
      path,
      body,
      context,
    });

    EventFlow.endEvent();
    return response.data;
  } catch (error) {
    EventFlow.fail(error);
    throw error;
  }
}

async function requestAgainstExistingEvent({ method, path, body, context = {} }) {
  await EventFlow.run(
    "client:prepare-request",
    async () => {
      EventFlow.addContext({
        requestPath: path,
        requestMethod: method,
        ...context,
      });
      await sleep(25);
    },
    { startIfMissing: true, eventName: "client.request" },
  );

  const response = await mockFetch(path, { method, body });

  const continuationToken =
    response.headers.get("x-eventflow-token") ?? response.data.continuationToken;

  if (continuationToken) {
    EventFlow.continueFromToken(continuationToken);
    EventFlow.step("client:continued-from-token");
  }

  EventFlow.step("client:response-received");
  EventFlow.addContext({
    httpStatus: response.status,
  });

  if (!response.ok) {
    throw new Error(response.data.error ?? `http-${response.status}`);
  }

  return response;
}

async function mockFetch(url, init = {}) {
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = {
    ...EventFlow.getPropagationHeaders(),
    "x-request-id": `web_${Math.random().toString(36).slice(2, 10)}`,
    ...(init.headers ?? {}),
  };

  const result = await server.request({
    method,
    url,
    headers,
    body: init.body ?? {},
  });

  state.serverEvents = server.getEmittedEvents();
  renderDebug();

  return {
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    headers: {
      get(name) {
        if (!name) {
          return null;
        }

        const key = String(name).toLowerCase();
        const found = Object.entries(result.headers ?? {}).find(
          ([headerName]) => headerName.toLowerCase() === key,
        );

        return found ? String(found[1]) : null;
      },
    },
    data: result.body ?? {},
    async json() {
      return result.body ?? {};
    },
  };
}

function syncServerEvents() {
  state.serverEvents = server.getEmittedEvents();
}

function renderTodos() {
  if (!elements.todoList) {
    return;
  }

  elements.todoList.innerHTML = "";

  for (const todo of state.todos) {
    const li = document.createElement("li");
    li.className = `todo-item${todo.done ? " done" : ""}`;

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = todo.text;

    const actions = document.createElement("div");
    actions.className = "todo-actions";

    const toggleButton = document.createElement("button");
    toggleButton.textContent = todo.done ? "Undo" : "Done";
    toggleButton.addEventListener("click", () => {
      void toggleTodo(todo.id);
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "danger";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      void deleteTodo(todo.id);
    });

    actions.append(toggleButton, deleteButton);
    li.append(text, actions);
    elements.todoList.appendChild(li);
  }
}

function renderDebug() {
  const active = EventFlow.getCurrentEvent();

  if (elements.clientActiveEl) {
    elements.clientActiveEl.textContent = active
      ? JSON.stringify(active, null, 2)
      : "(none)";
  }

  if (elements.clientEmittedEl) {
    elements.clientEmittedEl.textContent = JSON.stringify(state.clientEvents, null, 2);
  }

  if (elements.serverEmittedEl) {
    elements.serverEmittedEl.textContent = JSON.stringify(state.serverEvents, null, 2);
  }
}

function setStatus(message, isError = false) {
  if (!elements.statusEl) {
    return;
  }

  elements.statusEl.textContent = message;
  elements.statusEl.dataset.error = isError ? "true" : "false";
}

function toError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
