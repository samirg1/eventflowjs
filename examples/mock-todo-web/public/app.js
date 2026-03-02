import { ConsoleTransport, EventFlow } from "/eventflow/index.js";

const todoForm = document.querySelector("#todo-form");
const todoInput = document.querySelector("#todo-input");
const todoList = document.querySelector("#todo-list");
const simulateWebhookButton = document.querySelector("#simulate-webhook");

const clientActiveEl = document.querySelector("#client-active");
const clientEmittedEl = document.querySelector("#client-emitted");
const serverEmittedEl = document.querySelector("#server-emitted");

const state = {
  todos: [],
  clientEmitted: [],
  serverEmitted: [],
};

const captureTransport = {
  log(event) {
    state.clientEmitted.unshift(event);
    if (state.clientEmitted.length > 50) {
      state.clientEmitted.pop();
    }
    renderDebug();
  },
};

EventFlow.setTransport([new ConsoleTransport(), captureTransport]);

void loadTodos();
setInterval(renderDebug, 200);
initServerEventStream();

if (todoForm) {
  todoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createTodo();
  });
}

if (simulateWebhookButton) {
  simulateWebhookButton.addEventListener("click", () => {
    void simulateWebhook();
  });
}

async function loadTodos() {
  try {
    const data = await requestWithEvent({
      eventName: "todo.load",
      context: { action: "load" },
      request: (headers) => fetch("/api/todos", { headers }),
    });

    state.todos = data.todos ?? [];
    renderTodos();
  } catch (error) {
    console.error(error);
    alert(`Failed to load todos: ${toError(error).message}`);
  }
}

async function createTodo() {
  if (!todoInput) {
    return;
  }

  const text = todoInput.value.trim();
  if (!text) {
    return;
  }

  try {
    const data = await requestWithEvent({
      eventName: "todo.create",
      context: { action: "create", textLength: text.length },
      request: (headers) =>
        fetch("/api/todos", {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text }),
        }),
    });

    if (data.todo) {
      state.todos.unshift(data.todo);
    }
    todoInput.value = "";
    renderTodos();
  } catch (error) {
    console.error(error);
    alert(`Failed to create todo: ${toError(error).message}`);
  }
}

async function toggleTodo(id) {
  try {
    const data = await requestWithEvent({
      eventName: "todo.toggle",
      context: { action: "toggle", todoId: id },
      request: (headers) =>
        fetch(`/api/todos/${id}/toggle`, {
          method: "PATCH",
          headers,
        }),
    });

    const updated = data.todo;
    if (updated) {
      state.todos = state.todos.map((item) => (item.id === updated.id ? updated : item));
    }
    renderTodos();
  } catch (error) {
    console.error(error);
    alert(`Failed to toggle todo: ${toError(error).message}`);
  }
}

async function deleteTodo(id) {
  try {
    await requestWithEvent({
      eventName: "todo.delete",
      context: { action: "delete", todoId: id },
      request: (headers) =>
        fetch(`/api/todos/${id}`, {
          method: "DELETE",
          headers,
        }),
    });

    state.todos = state.todos.filter((item) => item.id !== id);
    renderTodos();
  } catch (error) {
    console.error(error);
    alert(`Failed to delete todo: ${toError(error).message}`);
  }
}

async function simulateWebhook() {
  EventFlow.startEvent("todo.webhookRoundTrip");
  EventFlow.addContext({ surface: "web", source: "simulate-button" });

  try {
    EventFlow.step("prepare-metadata");
    const metadata = EventFlow.getPropagationMetadata();

    const response = await fetch("/api/webhook/todo-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "todo_synced",
        metadata,
      }),
    });

    const data = await response.json();
    if (data.continuationToken) {
      EventFlow.continueFromToken(data.continuationToken);
    }

    EventFlow.step("webhook-response-received");
    EventFlow.addContext({ webhookStatus: response.status });

    if (!response.ok) {
      throw new Error(data.error ?? `webhook-http-${response.status}`);
    }

    EventFlow.endEvent();
  } catch (error) {
    EventFlow.fail(error);
    alert(`Webhook simulation failed: ${toError(error).message}`);
  }
}

async function requestWithEvent({ eventName, context, request }) {
  EventFlow.startEvent(eventName);
  EventFlow.addContext({
    surface: "web",
    ...context,
  });

  try {
    EventFlow.step("request-start");

    const headers = {
      ...EventFlow.getPropagationHeaders(),
      "x-request-id": `web_${Math.random().toString(36).slice(2, 10)}`,
    };

    const response = await request(headers);
    const data = await response.json().catch(() => ({}));

    const continuationToken =
      response.headers.get("x-eventflow-token") ?? data.continuationToken;

    if (continuationToken) {
      EventFlow.continueFromToken(continuationToken);
    }

    EventFlow.step("response-received");
    EventFlow.addContext({ httpStatus: response.status });

    if (!response.ok) {
      throw new Error(data.error ?? `http-${response.status}`);
    }

    EventFlow.endEvent();
    return data;
  } catch (error) {
    EventFlow.fail(error);
    throw error;
  }
}

function renderTodos() {
  if (!todoList) {
    return;
  }

  todoList.innerHTML = "";

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
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      void deleteTodo(todo.id);
    });

    actions.append(toggleButton, deleteButton);
    li.append(text, actions);
    todoList.appendChild(li);
  }
}

function renderDebug() {
  const active = EventFlow.getCurrentEvent();

  if (clientActiveEl) {
    clientActiveEl.textContent = active
      ? JSON.stringify(active, null, 2)
      : "(none)";
  }

  if (clientEmittedEl) {
    clientEmittedEl.textContent = JSON.stringify(state.clientEmitted, null, 2);
  }

  if (serverEmittedEl) {
    serverEmittedEl.textContent = JSON.stringify(state.serverEmitted, null, 2);
  }
}

function initServerEventStream() {
  const stream = new EventSource("/api/debug/stream");

  stream.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data);
      if (parsed.type === "connected") {
        return;
      }

      state.serverEmitted.unshift(parsed);
      if (state.serverEmitted.length > 50) {
        state.serverEmitted.pop();
      }
      renderDebug();
    } catch {
      // Ignore malformed stream items.
    }
  };
}

function toError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
