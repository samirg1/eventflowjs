import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ConsoleTransport, EventFlow } from "eventflowjs/react-native";

const DEFAULT_API_BASE =
  Platform.OS === "android"
    ? "http://10.0.2.2:4310"
    : "http://127.0.0.1:4310";

export default function App() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [todos, setTodos] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeEvent, setActiveEvent] = useState(null);
  const [clientEvents, setClientEvents] = useState([]);
  const [serverEvents, setServerEvents] = useState([]);

  useEffect(() => {
    const captureTransport = {
      log(event) {
        setClientEvents((prev) => [event, ...prev].slice(0, 30));
      },
    };

    EventFlow.setTransport([new ConsoleTransport(), captureTransport]);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveEvent(EventFlow.getCurrentEvent());
    }, 200);

    return () => clearInterval(timer);
  }, []);

  const apiUrl = useMemo(() => `${apiBase}/api`, [apiBase]);

  const requestWithEvent = useCallback(
    async ({ eventName, context, request }) => {
      EventFlow.startEvent(eventName);
      EventFlow.addContext({ surface: "react-native", ...context });

      try {
        EventFlow.step("request-start");
        const headers = {
          ...EventFlow.getPropagationHeaders(),
          "x-request-id": `rn_${Math.random().toString(36).slice(2, 10)}`,
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
    },
    [],
  );

  const loadTodos = useCallback(async () => {
    setLoading(true);

    try {
      const data = await requestWithEvent({
        eventName: "todo.load",
        context: { action: "load" },
        request: (headers) => fetch(`${apiUrl}/todos`, { headers }),
      });

      setTodos(data.todos ?? []);
    } catch (error) {
      console.warn("Load todos failed", error);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, requestWithEvent]);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${apiUrl}/debug/events`);
        const data = await response.json();
        setServerEvents((data.events ?? []).slice(0, 30));
      } catch {
        // Ignore polling errors while backend is unavailable.
      }
    }, 1500);

    return () => clearInterval(timer);
  }, [apiUrl]);

  const addTodo = useCallback(async () => {
    const text = input.trim();
    if (!text) {
      return;
    }

    setLoading(true);
    try {
      const data = await requestWithEvent({
        eventName: "todo.create",
        context: { action: "create", textLength: text.length },
        request: (headers) =>
          fetch(`${apiUrl}/todos`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
            },
            body: JSON.stringify({ text }),
          }),
      });

      if (data.todo) {
        setTodos((prev) => [data.todo, ...prev]);
      }
      setInput("");
    } catch (error) {
      console.warn("Create todo failed", error);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, input, requestWithEvent]);

  const toggleTodo = useCallback(
    async (id) => {
      setLoading(true);
      try {
        const data = await requestWithEvent({
          eventName: "todo.toggle",
          context: { action: "toggle", todoId: id },
          request: (headers) =>
            fetch(`${apiUrl}/todos/${id}/toggle`, {
              method: "PATCH",
              headers,
            }),
        });

        if (data.todo) {
          setTodos((prev) =>
            prev.map((item) => (item.id === data.todo.id ? data.todo : item)),
          );
        }
      } catch (error) {
        console.warn("Toggle todo failed", error);
      } finally {
        setLoading(false);
      }
    },
    [apiUrl, requestWithEvent],
  );

  const deleteTodo = useCallback(
    async (id) => {
      setLoading(true);
      try {
        await requestWithEvent({
          eventName: "todo.delete",
          context: { action: "delete", todoId: id },
          request: (headers) =>
            fetch(`${apiUrl}/todos/${id}`, {
              method: "DELETE",
              headers,
            }),
        });

        setTodos((prev) => prev.filter((item) => item.id !== id));
      } catch (error) {
        console.warn("Delete todo failed", error);
      } finally {
        setLoading(false);
      }
    },
    [apiUrl, requestWithEvent],
  );

  const simulateWebhook = useCallback(async () => {
    EventFlow.startEvent("todo.webhookRoundTrip");
    EventFlow.addContext({ surface: "react-native", source: "simulate-button" });

    try {
      EventFlow.step("prepare-metadata");
      const metadata = EventFlow.getPropagationMetadata();

      const response = await fetch(`${apiUrl}/webhook/todo-sync`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "todo_synced", metadata }),
      });

      const data = await response.json().catch(() => ({}));
      if (data.continuationToken) {
        EventFlow.continueFromToken(data.continuationToken);
      }

      EventFlow.step("webhook-response-received");
      EventFlow.endEvent();
    } catch (error) {
      EventFlow.fail(error);
    }
  }, [apiUrl]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>EventFlow RN Todo Mock</Text>
        <Text style={styles.subtitle}>
          Tracks client events, server continuation, and webhook metadata flow.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Backend URL</Text>
          <TextInput value={apiBase} onChangeText={setApiBase} style={styles.input} />

          <View style={styles.row}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Add todo..."
              style={[styles.input, styles.flex]}
            />
            <Pressable onPress={addTodo} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Add</Text>
            </Pressable>
          </View>

          <Pressable onPress={simulateWebhook} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Simulate Webhook</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Todos</Text>
          {loading ? <ActivityIndicator /> : null}

          <FlatList
            data={todos}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View style={[styles.todoItem, item.done ? styles.todoDone : null]}>
                <Text style={styles.todoText}>{item.text}</Text>
                <View style={styles.row}>
                  <Pressable
                    onPress={() => toggleTodo(item.id)}
                    style={styles.smallButton}
                  >
                    <Text style={styles.smallButtonText}>{item.done ? "Undo" : "Done"}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => deleteTodo(item.id)}
                    style={styles.smallButton}
                  >
                    <Text style={styles.smallButtonText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            )}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Client Active Event</Text>
          <Text style={styles.code}>{format(activeEvent)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Client Emitted Events</Text>
          <Text style={styles.code}>{format(clientEvents)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Server Emitted Events</Text>
          <Text style={styles.code}>{format(serverEvents)}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function format(value) {
  return value ? JSON.stringify(value, null, 2) : "(none)";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f8ff",
  },
  scrollContent: {
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#10233d",
  },
  subtitle: {
    color: "#475a75",
    marginBottom: 4,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d7e4f3",
    padding: 12,
    gap: 8,
  },
  label: {
    fontWeight: "600",
    color: "#24364f",
  },
  input: {
    borderWidth: 1,
    borderColor: "#b8cbe2",
    borderRadius: 8,
    padding: 10,
    backgroundColor: "#fff",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  flex: {
    flex: 1,
  },
  primaryButton: {
    backgroundColor: "#115efb",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: "#eff5ff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#b6c9e7",
    padding: 10,
  },
  secondaryButtonText: {
    color: "#1b365a",
    fontWeight: "600",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#10233d",
  },
  todoItem: {
    borderWidth: 1,
    borderColor: "#d9e4f4",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    backgroundColor: "#f9fbff",
    gap: 8,
  },
  todoDone: {
    opacity: 0.7,
  },
  todoText: {
    color: "#152b47",
  },
  smallButton: {
    borderWidth: 1,
    borderColor: "#b8cbe2",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#fff",
  },
  smallButtonText: {
    color: "#1e3554",
    fontWeight: "600",
    fontSize: 12,
  },
  code: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    color: "#c9f4ff",
    backgroundColor: "#081224",
    borderRadius: 8,
    padding: 10,
  },
});
