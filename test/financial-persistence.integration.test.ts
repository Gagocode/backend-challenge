import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';
import { WagerTransaction, WagerTransactionKind } from '../src/domain/wager-transaction/wager-transaction';
import { Money } from '../src/domain/money/money';
import { Wallet } from '../src/domain/wallet/wallet';
import { LedgerDirection } from '../src/domain/wallet/wallet-ledger-entry';
import { TypeOrmWagerTransactionRepository, TypeOrmWalletLedgerEntryRepository, TypeOrmWalletRepository } from '../src/persistence/repositories/financial-repositories';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
const suite = enabled ? describe : describe.skip;
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

suite('financial persistence against real PostgreSQL', () => {
  let dataSource: DataSource;
  let walletId: string;
  let transactionId: string;

  beforeAll(async () => {
    dataSource = new DataSource(createDatabaseOptions({ DATABASE_URL: databaseUrl }));
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  test('persists and rehydrates wallet, transaction and ledger with exact money', async () => {
    walletId = randomUUID(); transactionId = randomUUID();
    const wallet = Wallet.open({ id: walletId, playerId: randomUUID(), initialBalance: brl('100000000000000000.01') });
    const transaction = WagerTransaction.create({ id: transactionId, providerId: 'provider-integration', externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), payloadHash: 'a'.repeat(64), walletId, playerId: wallet.playerId, roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Bet, money: brl('0.01') });
    const entry = wallet.debit({ id: randomUUID(), transactionId, money: brl('0.01') });
    await dataSource.transaction(async (manager) => {
      const wallets = new TypeOrmWalletRepository(manager);
      const transactions = new TypeOrmWagerTransactionRepository(manager);
      const ledger = new TypeOrmWalletLedgerEntryRepository(manager);
      await wallets.save(wallet); await transactions.save(transaction); await ledger.save(entry);
    });
    const restored = await new TypeOrmWalletRepository(dataSource.manager).findById(walletId);
    const restoredTransaction = await new TypeOrmWagerTransactionRepository(dataSource.manager).findById(transactionId);
    const restoredEntry = await new TypeOrmWalletLedgerEntryRepository(dataSource.manager).findByWalletId(walletId);
    expect(restored?.balance.toString()).toBe('100000000000000000.00');
    expect(restoredTransaction?.money.toString()).toBe('0.01');
    expect(restoredEntry).toHaveLength(1); expect(restoredEntry[0]?.isBalanced()).toBe(true);
  });

  test('enforces uniqueness, foreign keys, non-negative balances and immutable ledger', async () => {
    const query = dataSource.createQueryRunner(); await query.connect();
    const duplicateExternal = `duplicate-external-${randomUUID()}`;
    const duplicateIdempotency = `same-idempotency-${randomUUID()}`;
    try {
      await expect(query.query('INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES ($1,$2,$3,$4,1,now(),now())', [walletId, randomUUID(), 'BRL', '-0.01'])).rejects.toThrow();
      await expect(query.query('INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, currency, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())', [randomUUID(), 'provider-integration', duplicateExternal, randomUUID(), 'b'.repeat(64), walletId, randomUUID(), 'r', 'g', 'BET', '1.00', 'BRL', 'PENDING'])).resolves.toBeDefined();
      await expect(query.query('INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, currency, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())', [randomUUID(), 'provider-integration', duplicateExternal, randomUUID(), 'b'.repeat(64), walletId, randomUUID(), 'r', 'g', 'BET', '1.00', 'BRL', 'PENDING'])).rejects.toThrow();
      await expect(query.query('INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, currency, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())', [randomUUID(), 'provider-integration', randomUUID(), duplicateIdempotency, 'b'.repeat(64), walletId, randomUUID(), 'r', 'g', 'BET', '1.00', 'BRL', 'PENDING'])).resolves.toBeDefined();
      await expect(query.query('INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, currency, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())', [randomUUID(), 'provider-integration', randomUUID(), duplicateIdempotency, 'c'.repeat(64), walletId, randomUUID(), 'r', 'g', 'BET', '1.00', 'BRL', 'PENDING'])).rejects.toThrow();
      await expect(query.query('INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, money_amount, currency, status, created_at, reference_transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14)', [randomUUID(), 'provider-integration', randomUUID(), randomUUID(), 'd'.repeat(64), walletId, randomUUID(), 'r', 'g', 'BET', '1.00', 'BRL', 'PENDING', randomUUID()])).rejects.toThrow();
      await expect(query.query('UPDATE wallet_ledger_entries SET money_amount = $1 WHERE wallet_id = $2', ['9.99', walletId])).rejects.toThrow();
      await expect(query.query('DELETE FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId])).rejects.toThrow();
      await expect(query.query('INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, money_amount, balance_before, balance_after, currency, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())', [randomUUID(), walletId, randomUUID(), LedgerDirection.Debit, '1.00', '0.00', '-1.00', 'BRL'])).rejects.toThrow();
      await expect(query.query('INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, money_amount, balance_before, balance_after, currency, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())', [randomUUID(), walletId, transactionId, LedgerDirection.Debit, '1.00', '1.00', '1.00', 'BRL'])).rejects.toThrow();
    } finally { await query.release(); }
  });

  test('acquires the wallet lock pessimistically inside a SQL transaction', async () => {
    const first = dataSource.createQueryRunner(); const second = dataSource.createQueryRunner();
    await first.connect(); await second.connect(); await first.startTransaction(); await second.startTransaction();
    try {
      await new TypeOrmWalletRepository(first.manager).findById(walletId, true);
      let completed = false;
      const pending = new TypeOrmWalletRepository(second.manager).findById(walletId, true).then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
      await first.commitTransaction();
      await pending;
      expect(completed).toBe(true);
      await second.commitTransaction();
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release(); await second.release();
    }
  });
});
