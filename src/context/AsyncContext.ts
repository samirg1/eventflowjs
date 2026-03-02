import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextManager, ContextState, EventLog } from "../types.js";

export class AsyncContext implements ContextManager {
  private readonly storage = new AsyncLocalStorage<ContextState>();

  getCurrentEvent(): EventLog | null {
    return this.storage.getStore()?.currentEvent ?? null;
  }

  setCurrentEvent(event: EventLog | null): void {
    const store = this.ensureStore();
    store.currentEvent = event;
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  setTraceId(traceId: string | undefined): void {
    const store = this.ensureStore();
    store.traceId = traceId;
  }

  clear(): void {
    const store = this.ensureStore();
    store.currentEvent = null;
    store.traceId = undefined;
  }

  private ensureStore(): ContextState {
    const current = this.storage.getStore();
    if (current) {
      return current;
    }

    const state: ContextState = {
      currentEvent: null,
      traceId: undefined,
    };
    this.storage.enterWith(state);
    return state;
  }
}
