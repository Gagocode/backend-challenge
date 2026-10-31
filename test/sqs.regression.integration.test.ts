import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('SQS regression against LocalStack and a real NestJS process', () => {
  let database: DataSource;
  let application: Bun.Subprocess;
  let sqs: SQSClient;
  const port = 33000 + (process.pid % 1000);
  const queueUrl = 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo';
  const outputQueueName = `wager-regression-events-${process.pid}.fifo`;
  const outputQueueUrl = `http://127.0.0.1:4566/000000000000/${outputQueueName}`;

  beforeAll(async () => {
    database = new DataSource(createDatabaseOptions({ ...process.env, DATABASE_URL: databaseUrl }));
    await database.initialize();
    sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    await sqs.send(new CreateQueueCommand({ QueueName: outputQueueName, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
    application = Bun.spawn([process.execPath, 'src/main.ts'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), NODE_ENV: 'test', SQS_ENDPOINT: 'http://127.0.0.1:4566', SQS_OUTPUT_QUEUE: outputQueueName, MESSAGING_WORKERS_ENABLED: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try { const health = await fetch(`http://127.0.0.1:${port}/health/live`); if (health.ok) return; } catch { /* process is starting */ }
      await Bun.sleep(100);
    }
    application.kill('SIGTERM');
    await application.exited;
    const stderr = application.stderr && typeof application.stderr !== 'number' ? await new Response(application.stderr).text() : '';
    throw new Error(`SQS regression process did not become ready: ${stderr}`);
  }, 30000);

  afterAll(async () => {
    sqs?.destroy();
    await database?.destroy();
    if (application) {
      application.kill('SIGTERM');
      await application.exited;
    }
  }, 30000);

  test('different envelope IDs for the same operation produce one financial effect', async () => {
    const playerId = crypto.randomUUID();
    const walletResponse = await fetch(`http://127.0.0.1:${port}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }) });
    expect(walletResponse.status).toBe(201);
    const wallet = await walletResponse.json() as { id: string; playerId: string };
    const walletId = wallet.id;
    const key = `sqs-regression-key-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    const messageIdA = `sqs-regression-a-${runId}`;
    const messageIdB = `sqs-regression-b-${runId}`;
    const common = { providerId: `sqs-regression-provider-${crypto.randomUUID()}`, externalTransactionId: `sqs-regression-external-${crypto.randomUUID()}`, idempotencyKey: key, playerId, walletId, roundId: 'sqs-regression-round', gameId: 'sqs-regression-game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
    const occurredAt = new Date().toISOString();
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ messageId: messageIdA, type: 'WagerTransactionRequested', occurredAt, data: common }), MessageGroupId: walletId, MessageDeduplicationId: `${runId}-dedup-a` }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ messageId: messageIdB, type: 'WagerTransactionRequested', occurredAt, data: common }), MessageGroupId: walletId, MessageDeduplicationId: `${runId}-dedup-b` }));

    let transactionRows: Array<{ status: string }> = [];
    const outputEvents: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 120; attempt += 1) {
      transactionRows = await database.query('SELECT status FROM wager_transactions WHERE provider_id = $1 AND idempotency_key = $2', [common.providerId, key]) as Array<{ status: string }>;
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: outputQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 5 }));
      for (const outputMessage of received.Messages ?? []) {
        try { outputEvents.push(JSON.parse(outputMessage.Body ?? '{}') as Record<string, unknown>); } catch { /* not an event */ }
        if (outputMessage.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: outputQueueUrl, ReceiptHandle: outputMessage.ReceiptHandle }));
      }
      if (transactionRows[0]?.status === 'PROCESSED' && outputEvents.some((event) => event.data && (event.data as Record<string, unknown>).walletId === walletId)) break;
      await Bun.sleep(250);
    }
    const ledgerRows = await database.query('SELECT count(*)::int AS count FROM wallet_ledger_entries le JOIN wager_transactions t ON t.id = le.transaction_id WHERE t.provider_id = $1 AND t.idempotency_key = $2', [common.providerId, key]) as Array<{ count: number }>;
    const inboxRows = await database.query('SELECT message_id, status FROM inbox_messages WHERE consumer_name = $1 AND message_id IN ($2, $3) ORDER BY message_id', ['wager-transaction-consumer', messageIdA, messageIdB]) as Array<{ message_id: string; status: string }>;
    expect(transactionRows).toHaveLength(1);
    expect(transactionRows[0]?.status).toBe('PROCESSED');
    expect(Number(ledgerRows[0]?.count)).toBe(1);
    expect(inboxRows.map((row) => [row.message_id, row.status])).toEqual([[messageIdA, 'PROCESSED'], [messageIdB, 'PROCESSED']]);
    expect(outputEvents.some((event) => event.eventType === 'WagerTransactionProcessed' && event.data && (event.data as Record<string, unknown>).walletId === walletId)).toBe(true);
  }, 60000);
});
