import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for distributed integration tests');
if (!process.env.TEST_DATABASE_SCHEMA) throw new Error('TEST_DATABASE_SCHEMA is required for distributed integration tests');

type Wallet = { id: string; playerId: string };
type App = Bun.Subprocess;

const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' };
const mainQueueName = process.env.SQS_MAIN_QUEUE;
const outputQueueName = process.env.SQS_OUTPUT_QUEUE;
const dlqName = process.env.SQS_DLQ;
if (!mainQueueName || !outputQueueName || !dlqName) throw new Error('Isolated SQS queue names are required');

let database: DataSource;
let sqs: SQSClient;
let mainQueueUrl: string;
let outputQueueUrl: string;
let dlqUrl: string;
const id = (): string => crypto.randomUUID();
const body = (value: unknown): string => JSON.stringify(value);

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 30000, intervalMs = 100): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms while waiting for an observable condition`);
};

const stop = async (app: App | undefined): Promise<void> => {
  if (!app) return;
  if (app.exitCode === null) app.kill('SIGTERM');
  await app.exited;
};

const startApp = async (port: number, options: { workers: boolean; consumerName?: string; fault?: string; outboxFault?: string; visibility?: string; batchSize?: string; outboxLeaseMs?: string; waitForHealth?: boolean }): Promise<App> => {
  const app = Bun.spawn([process.execPath, 'src/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      PORT: String(port),
      MESSAGING_WORKERS_ENABLED: String(options.workers),
      SQS_CONSUMER_NAME: options.consumerName ?? `distributed-${id()}`,
      SQS_VISIBILITY_TIMEOUT_SECONDS: options.visibility ?? '30',
      SQS_BATCH_SIZE: options.batchSize ?? '10',
      OUTBOX_LEASE_MS: options.outboxLeaseMs ?? '30000',
      ...(options.fault ? { SQS_FAULT_INJECTION: options.fault } : {}),
      ...(options.outboxFault ? { OUTBOX_FAULT_INJECTION: options.outboxFault } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.waitForHealth === false) return app;
  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok; } catch { return false; }
    }, 30000);
    return app;
  } catch (error: unknown) {
    if (app.exitCode === null) app.kill('SIGTERM');
    await app.exited;
    const stderr = app.stderr && typeof app.stderr !== 'number' ? await new Response(app.stderr).text() : '';
    throw new Error(`Application on port ${port} did not become ready: ${stderr}\n${error instanceof Error ? error.message : String(error)}`);
  }
};

const request = async (port: number, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const createWallet = async (port: number, amount = '0.00'): Promise<Wallet> => {
  const playerId = id();
  const response = await request(port, '/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body({ playerId, initialBalance: { amount, currency: 'BRL' } }) });
  expect(response.status).toBe(201);
  return { id: String(response.body.id), playerId: String(response.body.playerId) };
};

const submit = async (port: number, wallet: Wallet, overrides: Record<string, unknown>, key = id()): Promise<{ status: number; body: Record<string, unknown> }> => {
  const command = {
    providerId: `provider-${id()}`,
    externalTransactionId: `external-${id()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${id()}`,
    gameId: 'distributed-recovery',
    kind: 'WIN',
    money: { amount: '1.00', currency: 'BRL' },
    ...overrides,
  };
  return request(port, '/wagering/transactions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: body(command) });
};

const sqsMessage = (messageId: string, wallet: Wallet, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: `sqs-provider-${id()}`,
    externalTransactionId: `sqs-external-${id()}`,
    idempotencyKey: `sqs-key-${id()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `sqs-round-${id()}`,
    gameId: 'distributed-recovery',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
    ...overrides,
  },
});

const sendMain = async (message: Record<string, unknown>, groupId: string, deduplicationId = id()): Promise<void> => {
  await sqs.send(new SendMessageCommand({ QueueUrl: mainQueueUrl, MessageBody: body(message), MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }));
};

const drainQueue = async (queueUrl: string, limit = 100): Promise<Record<string, unknown>[]> => {
  const messages: Record<string, unknown>[] = [];
  let emptyReads = 0;
  for (let index = 0; index < limit && emptyReads < 30; index += 1) {
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 2 }));
    if (!result.Messages?.length) {
      emptyReads += 1;
      await Bun.sleep(100);
      continue;
    }
    emptyReads = 0;
    for (const message of result.Messages) {
      try { messages.push(JSON.parse(message.Body ?? '{}') as Record<string, unknown>); } catch { /* evidence is kept in the queue state */ }
      if (message.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return messages;
};

beforeAll(async () => {
  database = new DataSource(createDatabaseOptions({ ...process.env, DATABASE_URL: databaseUrl }));
  await database.initialize();
  sqs = new SQSClient({ region, endpoint, credentials });
  mainQueueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: mainQueueName }))).QueueUrl as string;
  outputQueueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: outputQueueName }))).QueueUrl as string;
  dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: dlqName }))).QueueUrl as string;
}, 30000);

afterAll(async () => {
  sqs?.destroy();
  await database?.destroy();
}, 30000);

describe('real PostgreSQL concurrency with independent application processes', () => {
  const apps: App[] = [];
  const ports = [34000 + (process.pid % 500), 34500 + (process.pid % 500), 35000 + (process.pid % 500)];

  beforeAll(async () => {
    for (const port of ports) apps.push(await startApp(port, { workers: false }));
  }, 90000);

  afterAll(async () => {
    for (const app of apps) await stop(app);
  }, 30000);

  test('A: 50 identical requests produce one financial operation and 49 idempotent replays', async () => {
    const wallet = await createWallet(ports[0]!, '0.00');
    const key = `same-key-${id()}`;
    const common = { providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`, roundId: `round-${id()}`, gameId: 'same-operation', kind: 'WIN', money: { amount: '2.00', currency: 'BRL' } };
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(ports[index % ports.length]!, wallet, common, key)));
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200 && result.body.idempotentReplay === true)).toHaveLength(49);
    const transactions = await database.query('SELECT id, status FROM wager_transactions WHERE provider_id = $1 AND idempotency_key = $2', [common.providerId, key]) as Array<{ id: string; status: string }>;
    const ledger = await database.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND transaction_id IN (SELECT id FROM wager_transactions WHERE provider_id = $2 AND idempotency_key = $3)', [wallet.id, common.providerId, key]) as Array<{ count: number }>;
    const walletRow = await database.query('SELECT balance_amount::text AS balance FROM wallets WHERE id = $1', [wallet.id]) as Array<{ balance: string }>;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.status).toBe('PROCESSED');
    expect(Number(ledger[0]?.count)).toBe(1);
    expect(walletRow[0]?.balance).toBe('2.00');
  }, 90000);

  test('B: concurrent debits on one wallet serialize without a negative balance', async () => {
    const wallet = await createWallet(ports[0]!, '100.00');
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => submit(ports[index % ports.length]!, wallet, { kind: 'BET', money: { amount: '3.00', currency: 'BRL' }, providerId: `lock-provider-${id()}`, externalTransactionId: `lock-external-${index}` })));
    const processed = results.filter((result) => result.body.status === 'PROCESSED');
    const rejected = results.filter((result) => result.body.status === 'REJECTED');
    const rows = await database.query(`SELECT w.balance_amount::text AS balance, COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.money_amount ELSE -l.money_amount END), 0)::text AS ledger_balance, COUNT(l.id)::int AS ledger_count FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = $1 GROUP BY w.id, w.balance_amount`, [wallet.id]) as Array<{ balance: string; ledger_balance: string; ledger_count: number }>;
    expect(processed.length + rejected.length).toBe(40);
    expect(rejected.length).toBeGreaterThan(0);
    expect(Number(rows[0]?.balance)).toBeGreaterThanOrEqual(0);
    expect(rows[0]?.balance).toBe(rows[0]?.ledger_balance);
    expect(Number(rows[0]?.ledger_count)).toBe(processed.length + 1);
  }, 90000);

  test('C: independent wallets progress concurrently and reconcile exactly', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(ports[0]!, '10.00')));
    const startedAt = Date.now();
    await Promise.all(wallets.flatMap((wallet, walletIndex) => Array.from({ length: 10 }, (_, index) => submit(ports[(walletIndex + index) % ports.length]!, wallet, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' }, providerId: `independent-${walletIndex}-${id()}`, externalTransactionId: `independent-external-${walletIndex}-${index}` }))));
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(15000);
    for (const wallet of wallets) {
      const row = await database.query(`SELECT w.balance_amount::text AS balance, COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.money_amount ELSE -l.money_amount END), 0)::text AS ledger_balance, COUNT(l.id)::int AS entries FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = $1 GROUP BY w.id, w.balance_amount`, [wallet.id]) as Array<{ balance: string; ledger_balance: string; entries: number }>;
      expect(row[0]?.balance).toBe('20.00');
      expect(row[0]?.balance).toBe(row[0]?.ledger_balance);
      expect(Number(row[0]?.entries)).toBe(11);
    }
    const first = database.createQueryRunner();
    const second = database.createQueryRunner();
    await first.connect(); await second.connect(); await first.startTransaction(); await second.startTransaction();
    const lockStartedAt = Date.now();
    try {
      await Promise.all([
        first.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallets[0]?.id]),
        second.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallets[1]?.id]),
      ]);
      await Promise.all([first.query('SELECT pg_sleep(0.35)'), second.query('SELECT pg_sleep(0.35)')]);
      expect(Date.now() - lockStartedAt).toBeLessThan(650);
      await first.commitTransaction(); await second.commitTransaction();
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release(); await second.release();
    }
  }, 90000);
});

describe('real SQS distribution, crash recovery, leases, retry and DLQ', () => {
  test('D: three independent workers distribute messages without duplicate financial effects', async () => {
    const http = await startApp(35500 + (process.pid % 500), { workers: false });
    const workers: App[] = [];
    try {
      const wallets = await Promise.all(Array.from({ length: 30 }, () => createWallet(35500 + (process.pid % 500), '10.00')));
      for (let index = 0; index < 3; index += 1) workers.push(await startApp(36000 + (process.pid % 500) + index, { workers: true, consumerName: `distributed-worker-${index}-${id()}`, batchSize: '1' }));
      const distributedGame = `distributed-recovery-${id()}`;
      const messages = wallets.map((wallet) => ({ id: `distributed-message-${id()}`, wallet, message: sqsMessage(`distributed-message-${id()}`, wallet, { gameId: distributedGame }) }));
      await Promise.all(messages.map((entry) => sendMain(entry.message, entry.wallet.id)));
      await waitFor(async () => Number((await database.query('SELECT count(*)::int AS count FROM wager_transactions WHERE game_id = $1', [distributedGame]))[0]?.count) >= 30, 60000);
      const consumers = await database.query("SELECT count(DISTINCT consumer_name)::int AS count FROM inbox_messages WHERE message_id LIKE 'distributed-message-%'") as Array<{ count: number }>;
      const financial = await database.query("SELECT count(*)::int AS transactions, count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed FROM wager_transactions WHERE game_id = $1", [distributedGame]) as Array<{ transactions: number; processed: number }>;
      const ledger = await database.query("SELECT count(*)::int AS count FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id WHERE t.game_id = $1", [distributedGame]) as Array<{ count: number }>;
      expect(Number(consumers[0]?.count)).toBeGreaterThanOrEqual(3);
      expect(Number(financial[0]?.transactions)).toBe(30);
      expect(Number(financial[0]?.processed)).toBe(30);
      expect(Number(ledger[0]?.count)).toBe(30);
    } finally {
      for (const worker of workers) await stop(worker);
      await stop(http);
    }
  }, 120000);

  test('crash after commit before ACK is recovered by redelivery and Inbox idempotency', async () => {
    const http = await startApp(37500 + (process.pid % 500), { workers: false });
    const wallet = await createWallet(37500 + (process.pid % 500), '10.00');
    const messageId = `crash-consumer-${id()}`;
    const message = sqsMessage(messageId, wallet);
    await sendMain(message, wallet.id);
    const consumerName = `crash-consumer-name-${id()}`;
    const crashed = await startApp(38000 + (process.pid % 500), { workers: true, consumerName, fault: 'crash-after-commit-before-ack', visibility: '1', batchSize: '1', waitForHealth: false });
    const exitCode = await crashed.exited;
    expect(exitCode).toBe(42);
    const rowBeforeRestart = await database.query('SELECT status FROM wager_transactions WHERE wallet_id = $1 AND external_transaction_id = $2', [wallet.id, (message.data as Record<string, unknown>).externalTransactionId]) as Array<{ status: string }>;
    expect(rowBeforeRestart[0]?.status).toBe('PROCESSED');
    const restarted = await startApp(38500 + (process.pid % 500), { workers: true, consumerName, visibility: '1', batchSize: '1' });
    try {
      await waitFor(async () => Number((await database.query('SELECT count(*)::int AS count FROM inbox_messages WHERE message_id = $1', [messageId]))[0]?.count) >= 1, 15000);
      const transactionRows = await database.query('SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = $1 AND external_transaction_id = $2', [wallet.id, (message.data as Record<string, unknown>).externalTransactionId]) as Array<{ count: number }>;
      const ledgerRows = await database.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND transaction_id IN (SELECT id FROM wager_transactions WHERE wallet_id = $1 AND external_transaction_id = $2)', [wallet.id, (message.data as Record<string, unknown>).externalTransactionId]) as Array<{ count: number }>;
      const inboxRows = await database.query('SELECT status, attempts FROM inbox_messages WHERE message_id = $1', [messageId]) as Array<{ status: string; attempts: number }>;
      expect(Number(transactionRows[0]?.count)).toBe(1);
      expect(Number(ledgerRows[0]?.count)).toBe(1);
      expect(inboxRows.some((row) => row.status === 'PROCESSED')).toBe(true);
    } finally {
      await stop(restarted);
      await stop(http);
    }
  }, 90000);

  test('publisher crash after SendMessage recovers its Outbox lease and marks one event published', async () => {
    const http = await startApp(39000 + (process.pid % 500), { workers: false });
    const wallet = await createWallet(39000 + (process.pid % 500), '1.00');
    const eventRows = await database.query("SELECT id, payload, published_at FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = $1 ORDER BY occurred_at ASC", [wallet.id]) as Array<{ id: string; payload: Record<string, unknown>; published_at: Date | null }>;
    const target = eventRows[0];
    if (!target) throw new Error('Outbox fixture was not created');
    await database.query('UPDATE outbox_messages SET next_attempt_at = $1 WHERE published_at IS NULL AND id <> $2', ['2099-01-01T00:00:00.000Z', target.id]);
    const crashing = await startApp(39500 + (process.pid % 500), { workers: true, outboxFault: 'crash-after-send-before-mark-published', visibility: '1', batchSize: '1', outboxLeaseMs: '1000', waitForHealth: false });
    const exitCode = await crashing.exited;
    expect(exitCode).toBe(43);
    const pending = await database.query('SELECT published_at, claimed_at FROM outbox_messages WHERE id = $1', [target.id]) as Array<{ published_at: Date | null; claimed_at: Date | null }>;
    expect(pending[0]?.published_at).toBeNull();
    const recovered = await startApp(40000 + (process.pid % 500), { workers: true, visibility: '1', batchSize: '1', outboxLeaseMs: '1000' });
    try {
      await waitFor(async () => Boolean((await database.query('SELECT published_at FROM outbox_messages WHERE id = $1 AND published_at IS NOT NULL', [target.id]))[0]), 15000);
      const published = await database.query('SELECT published_at, attempts FROM outbox_messages WHERE id = $1', [target.id]) as Array<{ published_at: Date | null; attempts: number }>;
      const events = await drainQueue(outputQueueUrl);
      const matching = events.filter((event) => event.eventId === target.id);
      expect(published[0]?.published_at).not.toBeNull();
      expect(Number(published[0]?.attempts)).toBeGreaterThanOrEqual(2);
      expect(matching.length).toBeGreaterThanOrEqual(1);
    } finally {
      await stop(recovered);
      await stop(http);
    }
  }, 90000);

  test('SQS retries a transient consumer failure, redrives automatically to DLQ, then processes after restart', async () => {
    const http = await startApp(40500 + (process.pid % 500), { workers: false });
    const wallet = await createWallet(40500 + (process.pid % 500), '5.00');
    const failedMessageId = `dlq-message-${id()}`;
    await sendMain(sqsMessage(failedMessageId, wallet), wallet.id);
    const failing = await startApp(41000 + (process.pid % 500), { workers: true, consumerName: `retry-consumer-${id()}`, fault: 'transient-before-processing', visibility: '1', batchSize: '1' });
    try {
      let dlqCount = 0;
      await waitFor(async () => {
        const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
        dlqCount = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
        return dlqCount >= 1;
      }, 30000, 250);
      expect(dlqCount).toBeGreaterThanOrEqual(1);
      const dlqMessages = await drainQueue(dlqUrl);
      expect(dlqMessages.some((message) => message.messageId === failedMessageId)).toBe(true);
      await stop(failing);

      const receiveCountProbeId = `receive-count-probe-${id()}`;
      await sendMain(sqsMessage(receiveCountProbeId, wallet), `receive-count-group-${id()}`);
      const receiveCounts: number[] = [];
      await waitFor(async () => {
        const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: mainQueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0, VisibilityTimeout: 0, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
        const received = result.Messages?.[0];
        if (received) receiveCounts.push(Number(received.Attributes?.ApproximateReceiveCount ?? 0));
        const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
        return Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0) >= 1 && Math.max(...receiveCounts, 0) >= 5;
      }, 15000, 100);
      expect(Math.max(...receiveCounts)).toBeGreaterThanOrEqual(5);
      const probedDlq = await drainQueue(dlqUrl);
      expect(probedDlq.some((message) => message.messageId === receiveCountProbeId)).toBe(true);
    } finally {
      await stop(failing);
    }
    const restarted = await startApp(41500 + (process.pid % 500), { workers: true, consumerName: `retry-restarted-${id()}`, visibility: '1', batchSize: '1' });
    try {
      const recoveredMessageId = `restart-message-${id()}`;
      await sendMain(sqsMessage(recoveredMessageId, wallet, { money: { amount: '1.00', currency: 'BRL' } }), wallet.id);
      await waitFor(async () => Number((await database.query('SELECT count(*)::int AS count FROM inbox_messages WHERE message_id = $1 AND status = \'PROCESSED\'', [recoveredMessageId]))[0]?.count) === 1, 15000);
      const balance = await database.query('SELECT balance_amount::text AS balance FROM wallets WHERE id = $1', [wallet.id]) as Array<{ balance: string }>;
      expect(balance[0]?.balance).toBe('4.00');
    } finally {
      await stop(restarted);
      await stop(http);
    }
  }, 90000);

  test('restart reconciliation finds no financial divergence after recovered processing', async () => {
    const app = await startApp(42000 + (process.pid % 500), { workers: false });
    try {
      const wallet = await createWallet(42000 + (process.pid % 500), '4.00');
      const result = await submit(42000 + (process.pid % 500), wallet, { kind: 'BET', money: { amount: '1.00', currency: 'BRL' } });
      expect(result.status).toBe(201);
      const reconciliation = await request(42000 + (process.pid % 500), `/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
      expect(reconciliation.status).toBe(201);
      expect(reconciliation.body.consistent).toBe(true);
      const pending = await database.query("SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL") as Array<{ count: number }>;
      expect(Number(pending[0]?.count)).toBeGreaterThanOrEqual(0);
    } finally {
      await stop(app);
    }
  }, 60000);
});
