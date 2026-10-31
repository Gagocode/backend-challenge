import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { TypeOrmFinancialUnitOfWork } from '../src/persistence/unit-of-work/typeorm-financial-unit-of-work';
import { TypeOrmInboxRepository, TypeOrmOutboxRepository } from '../src/persistence/repositories/messaging-repositories';
import { InboxMessageStatus } from '../src/domain/messaging/inbox-message';
import { Money } from '../src/domain/money/money';
import type { FinancialTransactionContext } from '../src/application/ports/financial-repositories';
import { TypeOrmWagerTransactionRepository } from '../src/persistence/repositories/financial-repositories';
import { WagerTransactionStatus } from '../src/domain/wager-transaction/wager-transaction';
import { OutboxPublisher } from '../src/messaging/sqs/outbox.publisher';
import { ProcessWagerTransactionUseCase } from '../src/application/use-cases/process-wager-transaction.use-case';
import { PendingReferenceWorker } from '../src/messaging/pending-reference.worker';
import { FailureCode } from '../src/domain/wager-transaction/wager-transaction';
import { WagerTransactionConsumer } from '../src/messaging/sqs/wager-transaction.consumer';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests; use bun run test:unit for infrastructure-free tests');
if (!process.env.TEST_DATABASE_SCHEMA) throw new Error('TEST_DATABASE_SCHEMA is required; use bun run test:integration to isolate PostgreSQL data');

describe('Inbox and Outbox persistence against real PostgreSQL', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(createDatabaseOptions({ ...process.env, DATABASE_URL: databaseUrl }));
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
  });

  afterAll(async () => { await dataSource.destroy(); });

  test('persists funded wallet, opening ledger and outbox atomically', async () => {
    const wallet = await new CreateWalletUseCase(new TypeOrmFinancialUnitOfWork(dataSource)).execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: Money.from({ amount: '12.00', currency: 'BRL' }) });
    const messages = await dataSource.query("SELECT event_type, published_at FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = $1 ORDER BY event_type", [wallet.id]) as Array<{ event_type: string; published_at: Date | null }>;
    expect(messages.map((message) => message.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(messages).toHaveLength(2);
  });

  test('rolls back the financial operation and its outbox events together', async () => {
    const walletId = randomUUID();
    const delegate = new TypeOrmFinancialUnitOfWork(dataSource);
    const failing = {
      execute: <T>(work: (context: FinancialTransactionContext) => Promise<T>) => delegate.execute(async (context) => {
        const result = await work(context);
        throw new Error(`forced rollback ${String(result)}`);
      }),
    };
    await expect(new CreateWalletUseCase(failing).execute({ id: walletId, playerId: randomUUID(), initialBalance: Money.from({ amount: '4.00', currency: 'BRL' }) })).rejects.toThrow('forced rollback');
    expect(await dataSource.query('SELECT 1 FROM wallets WHERE id = $1', [walletId])).toHaveLength(0);
    expect(await dataSource.query("SELECT 1 FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = $1", [walletId])).toHaveLength(0);
  });

  test('uses the persistent unique key for concurrent Inbox delivery', async () => {
    const messageId = randomUUID();
    const consumerName = `test-consumer-${randomUUID()}`;
    const payloadHash = 'a'.repeat(64);
    const receiveAndCommit = async () => dataSource.transaction(async (manager) => {
      const repository = new TypeOrmInboxRepository(manager);
      const result = await repository.receive(messageId, consumerName, payloadHash);
      if (!result.duplicate) {
        result.message.markProcessed(new Date());
        await repository.save(result.message);
      }
      return result;
    });
    const results = await Promise.all([receiveAndCommit(), receiveAndCommit()]);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.every((result) => result.message.status === InboxMessageStatus.Processed)).toBe(true);
  });

  test('claims one Outbox row once when publishers race', async () => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    const now = new Date();
    await dataSource.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, version, payload, occurred_at, created_at, attempts, next_attempt_at)
      VALUES ($1, $2, 'TestEvent', 1, $3::jsonb, $4, $4, 0, $4)`, [id, aggregateId, JSON.stringify({ eventId: id, eventType: 'TestEvent', version: 1, data: {} }), now]);
    const [first, second] = await Promise.all([
      dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).claimDue(1000, new Date(), 30000)),
      dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).claimDue(1000, new Date(), 30000)),
    ]);
    const claimed = [...first, ...second].filter((message) => message.id === id);
    expect(claimed).toHaveLength(1);
  });

  test('renews an active Outbox lease during a slow publish', async () => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    const now = new Date(0);
    const eventType = `SlowLease-${id}`;
    await dataSource.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, version, payload, occurred_at, created_at, attempts, next_attempt_at)
      VALUES ($1, $2, $3, 1, $4::jsonb, $5, $5, 0, $5)`, [id, aggregateId, eventType, JSON.stringify({ eventId: id, eventType, version: 1, data: {} }), now]);
    const blocked = await dataSource.query('SELECT id, next_attempt_at FROM outbox_messages WHERE published_at IS NULL AND id <> $1', [id]) as Array<{ id: string; next_attempt_at: Date }>;
    await dataSource.query("UPDATE outbox_messages SET next_attempt_at = '2099-01-01T00:00:00.000Z' WHERE published_at IS NULL AND id <> $1", [id]);
    const previousLease = process.env.OUTBOX_LEASE_MS;
    const previousBatchSize = process.env.OUTBOX_BATCH_SIZE;
    process.env.OUTBOX_LEASE_MS = '600';
    process.env.OUTBOX_BATCH_SIZE = '1';
    let sends = 0;
    const sqs = { send: async () => { sends += 1; await Bun.sleep(1500); } };
    try {
      const first = new OutboxPublisher(dataSource, sqs as never).publishBatch();
      await Bun.sleep(800);
      await new OutboxPublisher(dataSource, sqs as never).publishBatch();
      await first;
    } finally {
      for (const row of blocked) await dataSource.query('UPDATE outbox_messages SET next_attempt_at = $1 WHERE id = $2', [row.next_attempt_at, row.id]);
      if (previousLease === undefined) delete process.env.OUTBOX_LEASE_MS;
      else process.env.OUTBOX_LEASE_MS = previousLease;
      if (previousBatchSize === undefined) delete process.env.OUTBOX_BATCH_SIZE;
      else process.env.OUTBOX_BATCH_SIZE = previousBatchSize;
    }
    expect(sends).toBe(1);
    const row = await dataSource.query('SELECT published_at FROM outbox_messages WHERE id = $1', [id]) as Array<{ published_at: Date | null }>;
    expect(row[0]?.published_at).not.toBeNull();
  });

  test('renews an Outbox claim with its database token', async () => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    await dataSource.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, version, payload, occurred_at, created_at, attempts, next_attempt_at)
      VALUES ($1, $2, 'RenewDirect', 1, $3::jsonb, $4, $4, 0, $4)`, [id, aggregateId, JSON.stringify({ eventId: id, eventType: 'RenewDirect', version: 1, data: {} }), new Date(0)]);
    const claimed = await dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).claimDue(1000, new Date(), 600));
    const target = claimed.find((candidate) => candidate.id === id);
    if (!target?.claimToken) throw new Error('direct lease fixture was not claimed');
    const renewed = await dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).renewClaim(id, target.claimToken as string, new Date()));
    expect(renewed).toBe(true);
    await dataSource.query('DELETE FROM outbox_messages WHERE id = $1', [id]);
  });

  test('claims pending references persistently with backoff and recovers an expired claim', async () => {
    const wallet = await new CreateWalletUseCase(new TypeOrmFinancialUnitOfWork(dataSource)).execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: Money.zero('BRL') });
    const firstId = randomUUID();
    const firstNow = new Date(0);
    await dataSource.query(`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, currency, reference_external_transaction_id, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending-round', 'pending-game', 'REFUND', '1.00', 'BRL', 'missing-reference', 'PENDING_REFERENCE', $8)`, [firstId, `pending-provider-${firstId}`, `pending-external-${firstId}`, `pending-key-${firstId}`, 'a'.repeat(64), wallet.id, wallet.playerId, firstNow]);
    const blocked = await dataSource.query('SELECT id, pending_next_attempt_at FROM wager_transactions WHERE status = $1 AND id <> $2', ['PENDING_REFERENCE', firstId]) as Array<{ id: string; pending_next_attempt_at: Date | null }>;
    await dataSource.query("UPDATE wager_transactions SET pending_next_attempt_at = '2099-01-01T00:00:00.000Z' WHERE status = 'PENDING_REFERENCE' AND id <> $1", [firstId]);
    const claim = async () => dataSource.transaction(async (manager) => new TypeOrmWagerTransactionRepository(manager).claimPendingReferences(1, new Date(), 30000));
    try {
      const [one, two] = await Promise.all([claim(), claim()]);
      const owned = [...one, ...two].filter((candidate) => candidate.transaction.id === firstId);
      expect(owned).toHaveLength(1);
      const winner = owned[0];
      if (!winner) throw new Error('pending claim was not returned');
      await dataSource.transaction(async (manager) => new TypeOrmWagerTransactionRepository(manager).schedulePendingReferenceRetry(firstId, winner.claimToken, new Date(), 'reference still absent', 5000));
      const persisted = await dataSource.query('SELECT pending_attempts, pending_next_attempt_at, pending_claim_token FROM wager_transactions WHERE id = $1', [firstId]) as Array<{ pending_attempts: number; pending_next_attempt_at: Date; pending_claim_token: string | null }>;
      expect(Number(persisted[0]?.pending_attempts)).toBe(1);
      expect(persisted[0]?.pending_next_attempt_at).not.toBeNull();
      expect(persisted[0]?.pending_claim_token).toBeNull();
      await dataSource.query('UPDATE wager_transactions SET pending_claimed_at = $1 WHERE id = $2', [new Date(Date.now() - 60000), firstId]);
      const recovered = await claim();
      expect(recovered.some((candidate) => candidate.transaction.id === firstId)).toBe(false);
      await dataSource.query('UPDATE wager_transactions SET pending_next_attempt_at = $1 WHERE id = $2', [new Date(Date.now() - 1), firstId]);
      const dueAgain = await claim();
      const recoveredTarget = dueAgain.find((candidate) => candidate.transaction.id === firstId);
      expect(recoveredTarget).toBeDefined();
      expect(recoveredTarget?.attempts).toBe(2);
      await dataSource.query('UPDATE wager_transactions SET pending_claimed_at = $1 WHERE id = $2', [new Date(Date.now() - 60000), firstId]);
      const afterCrash = await claim();
      const crashRecoveryTarget = afterCrash.find((candidate) => candidate.transaction.id === firstId);
      expect(crashRecoveryTarget).toBeDefined();
      expect(crashRecoveryTarget?.attempts).toBe(3);
    } finally {
      for (const row of blocked) await dataSource.query('UPDATE wager_transactions SET pending_next_attempt_at = $1 WHERE id = $2', [row.pending_next_attempt_at, row.id]);
      await dataSource.query('DELETE FROM wager_transactions WHERE id = $1', [firstId]);
    }
  });

  test('expires an unresolved reference atomically, emits one rejection event, and safely retries after rollback', async () => {
    const wallet = await new CreateWalletUseCase(new TypeOrmFinancialUnitOfWork(dataSource)).execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: Money.zero('BRL') });
    const transactionId = randomUUID();
    const externalTransactionId = `expiration-external-${transactionId}`;
    const providerId = `expiration-provider-${transactionId}`;
    const idempotencyKey = `expiration-key-${transactionId}`;
    const processUseCase = new ProcessWagerTransactionUseCase(new TypeOrmFinancialUnitOfWork(dataSource));
    const pending = await processUseCase.execute({
      id: transactionId,
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash: 'c'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `expiration-round-${transactionId}`,
      gameId: 'expiration-test',
      kind: 'REFUND' as never,
      money: Money.from({ amount: '3.00', currency: 'BRL' }),
      referenceExternalTransactionId: `missing-reference-${transactionId}`,
      source: 'system',
    });
    expect(pending.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    await dataSource.query("UPDATE wager_transactions SET created_at = '2000-01-01T00:00:00.000Z', pending_next_attempt_at = NULL WHERE id = $1", [transactionId]);
    const previousTtl = process.env.PENDING_REFERENCE_TTL_MS;
    const previousInterval = process.env.PENDING_REFERENCE_INTERVAL_MS;
    process.env.PENDING_REFERENCE_TTL_MS = '1';
    process.env.PENDING_REFERENCE_INTERVAL_MS = '60000';

    const delegate = new TypeOrmFinancialUnitOfWork(dataSource);
    const failBeforeCommit = {
      execute: <T>(work: (context: FinancialTransactionContext) => Promise<T>) => delegate.execute(async (context) => {
        const result = await work(context);
        if (result && typeof result === 'object' && 'transaction' in result && (result as { transaction: { status?: string } }).transaction.status === WagerTransactionStatus.Rejected) {
          throw new Error('forced expiration rollback before commit');
        }
        return result;
      }),
    };
    const failedWorker = new PendingReferenceWorker(dataSource, delegate, new ProcessWagerTransactionUseCase(failBeforeCommit));
    try {
      failedWorker.onModuleInit();
      await failedWorker.processPending();
      const afterRollback = await dataSource.query('SELECT status, failure_code FROM wager_transactions WHERE id = $1', [transactionId]) as Array<{ status: string; failure_code: string | null }>;
      expect(afterRollback[0]).toEqual({ status: 'PENDING_REFERENCE', failure_code: null });
      const rejectionEventsAfterRollback = await dataSource.query("SELECT id FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload -> 'data' ->> 'transactionId' = $1", [transactionId]);
      expect(rejectionEventsAfterRollback).toHaveLength(0);
      const walletAfterRollback = await dataSource.query('SELECT balance_amount::text AS balance FROM wallets WHERE id = $1', [wallet.id]) as Array<{ balance: string }>;
      const ledgerAfterRollback = await dataSource.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id]) as Array<{ count: number }>;
      expect(walletAfterRollback[0]?.balance).toBe('0.00');
      expect(Number(ledgerAfterRollback[0]?.count)).toBe(0);

      await dataSource.query('UPDATE wager_transactions SET pending_next_attempt_at = $1 WHERE id = $2', [new Date(Date.now() - 1), transactionId]);
      const worker = new PendingReferenceWorker(dataSource, delegate, processUseCase);
      worker.onModuleInit();
      try {
        await worker.processPending();
        const rejected = await dataSource.query('SELECT status, failure_code FROM wager_transactions WHERE id = $1', [transactionId]) as Array<{ status: string; failure_code: string | null }>;
        expect(rejected[0]).toEqual({ status: 'REJECTED', failure_code: FailureCode.ReferenceNotFound });
        const rejectionEvents = await dataSource.query("SELECT id FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload -> 'data' ->> 'transactionId' = $1", [transactionId]);
        expect(rejectionEvents).toHaveLength(1);
        const finalWallet = await dataSource.query('SELECT balance_amount::text AS balance FROM wallets WHERE id = $1', [wallet.id]) as Array<{ balance: string }>;
        const finalLedger = await dataSource.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id]) as Array<{ count: number }>;
        expect(finalWallet[0]?.balance).toBe('0.00');
        expect(Number(finalLedger[0]?.count)).toBe(0);

        await worker.processPending();
        const afterRepeat = await dataSource.query('SELECT status, failure_code FROM wager_transactions WHERE id = $1', [transactionId]) as Array<{ status: string; failure_code: string | null }>;
        const rejectionEventsAfterRepeat = await dataSource.query("SELECT id FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload -> 'data' ->> 'transactionId' = $1", [transactionId]);
        expect(afterRepeat[0]).toEqual(rejected[0]);
        expect(rejectionEventsAfterRepeat).toHaveLength(1);
      } finally {
        await worker.onModuleDestroy();
      }
    } finally {
      await failedWorker.onModuleDestroy();
      if (previousTtl === undefined) delete process.env.PENDING_REFERENCE_TTL_MS;
      else process.env.PENDING_REFERENCE_TTL_MS = previousTtl;
      if (previousInterval === undefined) delete process.env.PENDING_REFERENCE_INTERVAL_MS;
      else process.env.PENDING_REFERENCE_INTERVAL_MS = previousInterval;
    }
  });

  test('rolls back Inbox and financial writes after an Outbox insert fault and recovers on same-message redelivery', async () => {
    const wallet = await new CreateWalletUseCase(new TypeOrmFinancialUnitOfWork(dataSource)).execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }) });
    const messageId = `precommit-message-${randomUUID()}`;
    const consumerName = `precommit-consumer-${randomUUID()}`;
    const providerId = `precommit-provider-${randomUUID()}`;
    const externalTransactionId = `precommit-external-${randomUUID()}`;
    const idempotencyKey = `${providerId}:${externalTransactionId}`;
    const occurredAt = new Date().toISOString();
    const initialOutboxRows = await dataSource.query("SELECT count(*)::int AS count FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = $1", [wallet.id]) as Array<{ count: number }>;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt,
      data: { providerId, externalTransactionId, idempotencyKey, playerId: wallet.playerId, walletId: wallet.id, roundId: `precommit-round-${randomUUID()}`, gameId: 'precommit-test', kind: 'BET', money: { amount: '3.00', currency: 'BRL' } },
    });
    const message = { Body: body, MessageId: `transport-${messageId}`, ReceiptHandle: `receipt-${messageId}`, Attributes: { ApproximateReceiveCount: '1' } };
    const delegate = new TypeOrmFinancialUnitOfWork(dataSource);
    let injectFailure = true;
    let retryCalls = 0;
    let deleteCalls = 0;
    let ackSnapshot: { inbox: string | undefined; transactions: number; ledger: number; outbox: number } | undefined;
    const failingUnitOfWork = {
      execute: <T>(work: (context: FinancialTransactionContext) => Promise<T>) => delegate.execute((context) => work({
        ...context,
        outbox: {
          claimDue: (...args) => context.outbox.claimDue(...args),
          renewClaim: (...args) => context.outbox.renewClaim(...args),
          markPublished: (...args) => context.outbox.markPublished(...args),
          scheduleRetry: (...args) => context.outbox.scheduleRetry(...args),
          enqueue: async (event) => {
            const inserted = await context.outbox.enqueue(event);
            if (injectFailure) {
              injectFailure = false;
              throw new Error('forced transient failure after real Outbox insert');
            }
            return inserted;
          },
        },
      })),
    };
    const sqs = {
      enabled: false,
      consumerName,
      visibilityTimeoutSeconds: 30,
      retry: async () => { retryCalls += 1; },
      delete: async () => {
        deleteCalls += 1;
        const inbox = await dataSource.query('SELECT status FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2', [consumerName, messageId]) as Array<{ status: string }>;
        const transactions = await dataSource.query('SELECT count(*)::int AS count FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2', [providerId, externalTransactionId]) as Array<{ count: number }>;
        const ledger = await dataSource.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id IN (SELECT id FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2)', [providerId, externalTransactionId]) as Array<{ count: number }>;
        const outbox = await dataSource.query("SELECT count(*)::int AS count FROM outbox_messages WHERE payload -> 'data' ->> 'transactionId' IN (SELECT id::text FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2)", [providerId, externalTransactionId]) as Array<{ count: number }>;
        ackSnapshot = { inbox: inbox[0]?.status, transactions: Number(transactions[0]?.count), ledger: Number(ledger[0]?.count), outbox: Number(outbox[0]?.count) };
      },
    };
    const consumer = new WagerTransactionConsumer(sqs as never, failingUnitOfWork, new ProcessWagerTransactionUseCase(delegate));

    await consumer.processMessage(message as never);
    expect(retryCalls).toBe(1);
    expect(deleteCalls).toBe(0);
    const afterFailureInbox = await dataSource.query('SELECT status FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2', [consumerName, messageId]) as Array<{ status: string }>;
    const afterFailureTransaction = await dataSource.query('SELECT count(*)::int AS count FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2', [providerId, externalTransactionId]) as Array<{ count: number }>;
    const afterFailureWallet = await dataSource.query('SELECT balance_amount::text AS balance FROM wallets WHERE id = $1', [wallet.id]) as Array<{ balance: string }>;
    const afterFailureLedger = await dataSource.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND transaction_id IN (SELECT id FROM wager_transactions WHERE provider_id = $2)', [wallet.id, providerId]) as Array<{ count: number }>;
    const afterFailureOutbox = await dataSource.query("SELECT count(*)::int AS count FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = $1", [wallet.id]) as Array<{ count: number }>;
    expect(afterFailureInbox).toHaveLength(0);
    expect(Number(afterFailureTransaction[0]?.count)).toBe(0);
    expect(afterFailureWallet[0]?.balance).toBe('10.00');
    expect(Number(afterFailureLedger[0]?.count)).toBe(0);
    expect(Number(afterFailureOutbox[0]?.count)).toBe(Number(initialOutboxRows[0]?.count));

    await consumer.processMessage({ ...message, Attributes: { ApproximateReceiveCount: '2' } } as never);
    expect(retryCalls).toBe(1);
    expect(deleteCalls).toBe(1);
    expect(ackSnapshot).toEqual({ inbox: 'PROCESSED', transactions: 1, ledger: 1, outbox: 2 });
    const finalWallet = await dataSource.query('SELECT balance_amount::text AS balance FROM wallets WHERE id = $1', [wallet.id]) as Array<{ balance: string }>;
    const finalInbox = await dataSource.query('SELECT status, attempts FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2', [consumerName, messageId]) as Array<{ status: string; attempts: number }>;
    const finalTransactions = await dataSource.query('SELECT count(*)::int AS count FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2', [providerId, externalTransactionId]) as Array<{ count: number }>;
    const finalLedger = await dataSource.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND transaction_id IN (SELECT id FROM wager_transactions WHERE provider_id = $2)', [wallet.id, providerId]) as Array<{ count: number }>;
    const finalOutbox = await dataSource.query("SELECT event_type FROM outbox_messages WHERE payload -> 'data' ->> 'transactionId' IN (SELECT id::text FROM wager_transactions WHERE provider_id = $1)", [providerId]) as Array<{ event_type: string }>;
    expect(finalInbox[0]?.status).toBe('PROCESSED');
    expect(Number(finalInbox[0]?.attempts)).toBe(1);
    expect(Number(finalTransactions[0]?.count)).toBe(1);
    expect(finalWallet[0]?.balance).toBe('7.00');
    expect(Number(finalLedger[0]?.count)).toBe(1);
    expect(finalOutbox.map((row) => row.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
});
