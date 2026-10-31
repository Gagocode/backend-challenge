export interface SqsConfig {
  endpoint?: string;
  region: string;
  mainQueue: string;
  outputQueue: string;
  dlq: string;
  visibilityTimeoutSeconds: number;
  receiveWaitSeconds: number;
  batchSize: number;
  consumerName: string;
  enabled: boolean;
}

export const createSqsConfig = (environment: NodeJS.ProcessEnv = process.env): SqsConfig => ({
  endpoint: environment.SQS_ENDPOINT,
  region: environment.AWS_REGION ?? 'us-east-1',
  mainQueue: environment.SQS_MAIN_QUEUE ?? 'wager-transactions.fifo',
  outputQueue: environment.SQS_OUTPUT_QUEUE ?? 'wager-integration-events.fifo',
  dlq: environment.SQS_DLQ ?? 'wager-transactions-dlq.fifo',
  visibilityTimeoutSeconds: Number(environment.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
  receiveWaitSeconds: Number(environment.SQS_RECEIVE_WAIT_SECONDS ?? 0),
  batchSize: Number(environment.SQS_BATCH_SIZE ?? 10),
  consumerName: environment.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer',
  enabled: environment.MESSAGING_WORKERS_ENABLED !== 'false',
});
