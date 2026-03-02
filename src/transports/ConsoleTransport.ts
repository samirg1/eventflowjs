import type { EventFlowClientConfig, EventLog, Transport } from "../types.js";

function rgb(r: number, g: number, b: number) {
    return `\x1b[38;2;${r};${g};${b}m`;
}

function formatPrefix() {
    const reset = "\x1b[0m";

    const purple = rgb(18, 44, 85);
    const teal = rgb(17, 181, 160);

    return `${purple}[Event${teal}Flow]${reset}`;
}

export class ConsoleTransport implements Transport {
    private branding = true;

    configure(config: EventFlowClientConfig): void {
        this.branding = config.branding;
    }

    log(event: EventLog): void {
        const payload = JSON.stringify(event, null, 2);
        if (!this.branding) {
            console.log(payload);
            return;
        }

        console.log(`${formatPrefix()} ${payload}`);
    }
}
