import type { EventLog, Transport } from "../types.js";

export class ConsoleTransport implements Transport {
  log(event: EventLog): void {
    console.log(JSON.stringify(event));
  }
}
