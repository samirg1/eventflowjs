import { EventFlow } from "../src/index.js";

interface QueueMessage {
  jobId: string;
  continuationToken: string;
  attempt: number;
}

const runReportJob = EventFlow.instrument(
  "runReportJob",
  async (message: QueueMessage) => {
    await EventFlow.run("fetch-source-data", async () => {
      // Simulate one transient failure on first attempt.
      if (message.attempt === 1) {
        throw new Error("upstream-timeout");
      }

      await sleep(20);
    }, { failEventOnError: false });

    await EventFlow.run("render-report", async () => {
      await sleep(15);
    });

    await EventFlow.run("upload-report", async () => {
      await sleep(10);
      EventFlow.addContext({ reportUrl: `https://cdn.example/reports/${message.jobId}.pdf` });
    });
  },
  {
    startIfMissing: false,
    endIfStarted: false,
    failEventOnError: false,
    contextFromArgs: (message) => ({
      jobId: message.jobId,
      queueAttempt: message.attempt,
    }),
  },
);

async function produceAndConsume(): Promise<void> {
  EventFlow.startEvent("generateMonthlyReport");
  EventFlow.addContext({
    accountId: "acct_100",
    reportMonth: "2026-02",
  });
  EventFlow.step("queue-job");

  const initialToken = EventFlow.getContinuationToken();
  EventFlow.endEvent("cancelled");

  if (!initialToken) {
    throw new Error("missing-continuation-token");
  }

  await processQueueMessage({
    jobId: "job_9001",
    continuationToken: initialToken,
    attempt: 1,
  });
}

async function processQueueMessage(message: QueueMessage): Promise<void> {
  const attached = EventFlow.continueFromToken(message.continuationToken);
  if (!attached) {
    EventFlow.startEvent("worker-report");
  }

  try {
    await runReportJob(message);
    EventFlow.endEvent();
  } catch (error) {
    const isRetriable = message.attempt < 2;

    EventFlow.addContext({
      jobError: error instanceof Error ? error.message : String(error),
      retryScheduled: isRetriable,
    });

    if (!isRetriable) {
      EventFlow.fail(error);
      return;
    }

    const nextToken = EventFlow.getContinuationToken();
    EventFlow.endEvent("cancelled");

    if (!nextToken) {
      return;
    }

    await processQueueMessage({
      ...message,
      continuationToken: nextToken,
      attempt: message.attempt + 1,
    });
  }
}

void produceAndConsume();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
