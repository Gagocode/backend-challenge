import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createDatabaseOptions } from '../src/database/database.config';

const integrationTests = [
  'test/financial-persistence.integration.test.ts',
  'test/financial-use-cases.integration.test.ts',
  'test/http.e2e.test.ts',
  'test/messaging.integration.test.ts',
  'test/sqs.regression.integration.test.ts',
];

const databaseUrl = process.env.DATABASE_URL;
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
const awsRegion = process.env.AWS_REGION ?? 'us-east-1';
const awsCredentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
};

if (!databaseUrl) {
  console.error('Integration tests require DATABASE_URL. Run bun run test:unit for infrastructure-free tests.');
  process.exit(1);
}

const runToken = randomUUID().replaceAll('-', '').slice(0, 20);
const schema = `it_${runToken}`;
const queueNames = {
  main: `wager-it-${runToken}-main.fifo`,
  dlq: `wager-it-${runToken}-dlq.fifo`,
  output: `wager-it-${runToken}-output.fifo`,
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function createQueues(sqs: SQSClient): Promise<void> {
  const dlq = await sqs.send(new CreateQueueCommand({
    QueueName: queueNames.dlq,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
  if (!dlq.QueueUrl) throw new Error('LocalStack did not return the integration DLQ URL');
  const dlqAttributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('LocalStack did not return the integration DLQ ARN');

  await sqs.send(new CreateQueueCommand({
    QueueName: queueNames.main,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: '30',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '5' }),
    },
  }));
  await sqs.send(new CreateQueueCommand({
    QueueName: queueNames.output,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
}

async function deleteQueue(sqs: SQSClient, name: string): Promise<void> {
  try {
    const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;
    if (url) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  } catch (error: unknown) {
    console.error(`Could not clean integration queue ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const pg = new Client({ connectionString: databaseUrl });
  const sqs = new SQSClient({ region: awsRegion, endpoint: sqsEndpoint, credentials: awsCredentials });
  let dataSource: DataSource | undefined;
  let exitCode = 1;
  try {
    await pg.connect();
    await pg.query('SELECT 1');
    await pg.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await pg.end();

    const testEnvironment = { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_SCHEMA: schema };
    dataSource = new DataSource(createDatabaseOptions(testEnvironment));
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    await dataSource.destroy();
    dataSource = undefined;

    await createQueues(sqs);

    const requestedTests = Bun.argv.slice(2);
    const tests = requestedTests.length ? requestedTests : integrationTests;
    const child = Bun.spawn([process.execPath, 'test', ...tests], {
      env: {
        ...testEnvironment,
        SQS_ENDPOINT: sqsEndpoint,
        SQS_MAIN_QUEUE: queueNames.main,
        SQS_DLQ: queueNames.dlq,
        SQS_OUTPUT_QUEUE: queueNames.output,
        SQS_CONSUMER_NAME: `wager-it-consumer-${runToken}`,
        MESSAGING_WORKERS_ENABLED: 'false',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    exitCode = await child.exited;
  } catch (error: unknown) {
    console.error(`Integration preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (dataSource?.isInitialized) await dataSource.destroy();
    try {
      const cleanup = new Client({ connectionString: databaseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await cleanup.end();
    } catch (error: unknown) {
      console.error(`Could not clean integration schema ${schema}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deleteQueue(sqs, queueNames.main);
    await deleteQueue(sqs, queueNames.dlq);
    await deleteQueue(sqs, queueNames.output);
    sqs.destroy();
  }
  process.exitCode = exitCode;
}

void main();
