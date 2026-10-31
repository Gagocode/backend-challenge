import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';
import { FinancialConflictError, InvalidFinancialOperationError } from '../src/application/financial-errors';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase, type ProcessWagerTransactionCommand } from '../src/application/use-cases/process-wager-transaction.use-case';
import { TypeOrmFinancialUnitOfWork } from '../src/persistence/unit-of-work/typeorm-financial-unit-of-work';
import { TypeOrmWagerTransactionRepository, TypeOrmWalletLedgerEntryRepository, TypeOrmWalletRepository } from '../src/persistence/repositories/financial-repositories';
import { Money } from '../src/domain/money/money';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../src/domain/wager-transaction/wager-transaction';
import { LedgerDirection } from '../src/domain/wallet/wallet-ledger-entry';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests; use bun run test:unit for infrastructure-free tests');
if (!process.env.TEST_DATABASE_SCHEMA) throw new Error('TEST_DATABASE_SCHEMA is required; use bun run test:integration to isolate PostgreSQL data');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('financial application use cases against real PostgreSQL', () => {
  let dataSource: DataSource;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    dataSource = new DataSource(createDatabaseOptions({ ...process.env, DATABASE_URL: databaseUrl }));
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const unitOfWork = new TypeOrmFinancialUnitOfWork(dataSource);
    createWallet = new CreateWalletUseCase(unitOfWork);
    processTransaction = new ProcessWagerTransactionUseCase(unitOfWork);
  });

  afterAll(async () => { await dataSource.destroy(); });

  const command = (walletId: string, playerId: string, kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>, amount: string, suffix = randomUUID(), extra: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => ({
    providerId: 'provider-use-case', externalTransactionId: `external-${suffix}`, idempotencyKey: `idempotency-${suffix}`, payloadHash: 'a'.repeat(64),
    walletId, playerId, roundId: `round-${suffix}`, gameId: 'game-use-case', kind, money: brl(amount), ...extra,
  });

  test('creates an empty wallet without an opening transaction or ledger entry', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('0.00') });
    const transactions = new TypeOrmWagerTransactionRepository(dataSource.manager);
    const ledger = new TypeOrmWalletLedgerEntryRepository(dataSource.manager);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(await transactions.findByProviderAndExternalId('internal', `opening:${wallet.id}`)).toBeUndefined();
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(0);
  });

  test('creates a funded wallet atomically with OPENING and CREDIT ledger', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('100.00') });
    const transactions = new TypeOrmWagerTransactionRepository(dataSource.manager);
    const ledger = new TypeOrmWalletLedgerEntryRepository(dataSource.manager);
    const opening = await transactions.findByProviderAndExternalId('internal', `opening:${wallet.id}`);
    const entries = await ledger.findByWalletId(wallet.id);
    expect(opening?.kind).toBe(WagerTransactionKind.Opening);
    expect(opening?.status).toBe(WagerTransactionStatus.Processed);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(entries[0]?.balanceBefore.toString()).toBe('0.00');
    expect(entries[0]?.balanceAfter.toString()).toBe('100.00');
  });

  test('rejects a duplicate wallet for the same player and currency', async () => {
    const playerId = randomUUID();
    await createWallet.execute({ id: randomUUID(), playerId, initialBalance: brl('0.00') });
    await expect(createWallet.execute({ id: randomUUID(), playerId, initialBalance: brl('0.00') })).rejects.toThrow();
  });

  test('does not leave a wallet when opening persistence fails', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const tooLarge = brl('100000000000000000000.00');
    await expect(createWallet.execute({ id: walletId, playerId, initialBalance: tooLarge })).rejects.toThrow();
    expect(await new TypeOrmWalletRepository(dataSource.manager).findById(walletId)).toBeUndefined();
  });

  test('processes BET, rejects insufficient BET and persists the correct ledger state', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('50.00') });
    const first = await processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '30.00'));
    const rejected = await processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '30.00'));
    const restored = await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id);
    const entries = await new TypeOrmWalletLedgerEntryRepository(dataSource.manager).findByWalletId(wallet.id);
    expect(first.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(rejected.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.transaction.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(restored?.balance.toString()).toBe('20.00');
    expect(entries.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
  });

  test('rejects a transaction whose player does not own the wallet without persistence or financial side effects', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('50.00') });
    const invalid = command(wallet.id, randomUUID(), WagerTransactionKind.Bet, '5.00');
    const transactions = new TypeOrmWagerTransactionRepository(dataSource.manager);
    const ledger = new TypeOrmWalletLedgerEntryRepository(dataSource.manager);
    const beforeEntries = await ledger.findByWalletId(wallet.id);

    await expect(processTransaction.execute(invalid)).rejects.toBeInstanceOf(InvalidFinancialOperationError);

    expect(await transactions.findByProviderAndExternalId(invalid.providerId, invalid.externalTransactionId)).toBeUndefined();
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(beforeEntries.length);
    expect((await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id))?.balance.toString()).toBe('50.00');
  });

  test('rejects a transaction with a currency different from the wallet without persistence or financial side effects', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('50.00') });
    const invalid = { ...command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '5.00'), money: Money.from({ amount: '5.00', currency: 'USD' }) };
    const transactions = new TypeOrmWagerTransactionRepository(dataSource.manager);
    const ledger = new TypeOrmWalletLedgerEntryRepository(dataSource.manager);
    const beforeEntries = await ledger.findByWalletId(wallet.id);

    await expect(processTransaction.execute(invalid)).rejects.toBeInstanceOf(InvalidFinancialOperationError);

    expect(await transactions.findByProviderAndExternalId(invalid.providerId, invalid.externalTransactionId)).toBeUndefined();
    expect(await ledger.findByWalletId(wallet.id)).toHaveLength(beforeEntries.length);
    expect((await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id))?.balance.toString()).toBe('50.00');
  });

  test('processes WIN and LOSS according to their balance effects', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('0.00') });
    const win = await processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Win, '25.00'));
    const loss = await processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Loss, '25.00'));
    const restored = await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id);
    const entries = await new TypeOrmWalletLedgerEntryRepository(dataSource.manager).findByWalletId(wallet.id);
    expect(win.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(restored?.balance.toString()).toBe('25.00');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe(LedgerDirection.Credit);
  });

  test('processes REFUND and ROLLBACK, and rejects a duplicate reversal', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('100.00') });
    const bet = command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '20.00');
    const processedBet = await processTransaction.execute(bet);
    const refund = await processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '20.00', randomUUID(), { referenceExternalTransactionId: bet.externalTransactionId, roundId: bet.roundId }));
    expect(refund.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.transaction.referenceTransactionId).toBe(processedBet.transaction.id);
    await expect(processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '20.00', randomUUID(), { referenceExternalTransactionId: bet.externalTransactionId, roundId: bet.roundId }))).rejects.toThrow();

    const rollbackBet = command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '10.00');
    await processTransaction.execute(rollbackBet);
    const rollback = await processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Rollback, '10.00', randomUUID(), { referenceExternalTransactionId: rollbackBet.externalTransactionId, roundId: rollbackBet.roundId }));
    const restored = await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id);
    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(restored?.balance.toString()).toBe('100.00');
  });

  test('replays identical idempotency requests and rejects a different payload', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('20.00') });
    const original = command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '5.00');
    const first = await processTransaction.execute(original);
    const replay = await processTransaction.execute(original);
    const conflict = { ...original, payloadHash: 'b'.repeat(64), money: brl('6.00') };
    await expect(processTransaction.execute(conflict)).rejects.toBeInstanceOf(FinancialConflictError);
    const entries = await new TypeOrmWalletLedgerEntryRepository(dataSource.manager).findByWalletId(wallet.id);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(entries.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
  });

  test('reprocesses a pending reference after the referenced BET arrives', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('7.00') });
    const referenceExternal = `future-bet-${randomUUID()}`;
    const pendingRound = `round-pending-${randomUUID()}`;
    const refund = command(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '7.00', randomUUID(), { referenceExternalTransactionId: referenceExternal, roundId: pendingRound });
    const pending = await processTransaction.execute(refund);
    expect(pending.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    const bet = command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '7.00', randomUUID(), { externalTransactionId: referenceExternal, roundId: pendingRound });
    await processTransaction.execute(bet);
    const completed = await processTransaction.execute(refund);
    const restored = await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id);
    expect(completed.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(restored?.balance.toString()).toBe('7.00');
  });

  test('serializes concurrent bets on one wallet and rolls back a failed database operation', async () => {
    const wallet = await createWallet.execute({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('100.00') });
    const bets = await Promise.all([
      processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '80.00')),
      processTransaction.execute(command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '80.00')),
    ]);
    const restored = await new TypeOrmWalletRepository(dataSource.manager).findById(wallet.id);
    expect(bets.filter((result) => result.transaction.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(bets.filter((result) => result.transaction.failureCode === FailureCode.InsufficientBalance)).toHaveLength(1);
    expect(restored?.balance.toString()).toBe('20.00');

    const beforeEntries = await new TypeOrmWalletLedgerEntryRepository(dataSource.manager).findByWalletId(wallet.id);
    const failed = command(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00', randomUUID(), { payloadHash: 'invalid-hash' });
    await expect(processTransaction.execute(failed)).rejects.toThrow();
    const afterEntries = await new TypeOrmWalletLedgerEntryRepository(dataSource.manager).findByWalletId(wallet.id);
    const missingTransaction = await new TypeOrmWagerTransactionRepository(dataSource.manager).findByProviderAndExternalId(failed.providerId, failed.externalTransactionId);
    expect(afterEntries).toHaveLength(beforeEntries.length);
    expect(missingTransaction).toBeUndefined();
  });
});
