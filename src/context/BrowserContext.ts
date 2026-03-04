import type { ContextManager, EventLog } from "../types.js";

/**
 * In-memory browser context state for the active event lifecycle.
 */
interface BrowserState {
  /**
   * Currently active event for this browser context.
   *
   * @default null
   */
  currentEvent: EventLog | null;
  /**
   * Active trace ID used for newly created sibling events.
   *
   * @default undefined
   */
  traceId?: string;
}

export class BrowserContext implements ContextManager {
  private state: BrowserState = {
    currentEvent: null,
    traceId: undefined,
  };

  getCurrentEvent(): EventLog | null {
    return this.state.currentEvent;
  }

  setCurrentEvent(event: EventLog | null): void {
    this.state.currentEvent = event;
  }

  getTraceId(): string | undefined {
    return this.state.traceId;
  }

  setTraceId(traceId: string | undefined): void {
    this.state.traceId = traceId;
  }

  clear(): void {
    this.state.currentEvent = null;
    this.state.traceId = undefined;
  }
}
