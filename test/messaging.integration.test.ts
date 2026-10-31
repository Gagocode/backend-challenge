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

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('Inbox and Outbox persistence against real PostgreSQL', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(createDatabaseOptions({ DATABASE_URL: databaseUrl }));
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
});
