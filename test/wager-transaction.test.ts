import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money/money';
import { LedgerDirection } from '../src/domain/wallet/wallet-ledger-entry';
import {
  FailureCode,
  InvalidWagerTransactionError,
  InvalidWagerTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/wager-transaction/wager-transaction';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const create = (overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
  WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    ...overrides,
  });

describe('WagerTransaction creation and queries', () => {
  test('creates every supported kind in PENDING', () => {
    for (const kind of [
      WagerTransactionKind.Opening,
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      const transaction = create({
        id: `id-${kind}`,
        externalTransactionId: `external-${kind}`,
        idempotencyKey: `key-${kind}`,
        kind,
        referenceExternalTransactionId:
          kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
            ? 'external-reference'
            : undefined,
      });
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.kind).toBe(kind);
    }
  });

  test('requires external references only for reversals and rejects invalid input', () => {
    expect(() => create({ kind: WagerTransactionKind.Refund })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => create({ kind: WagerTransactionKind.Rollback })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => create({ id: '' })).toThrow(InvalidWagerTransactionError);
    expect(() => create({ money: brl('1.00').negate() })).toThrow(InvalidWagerTransactionError);
  });

  test('reports balance effect, reference requirement, payload and ledger direction', () => {
    expect(create({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(true);
    expect(create({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(create({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ref' }).requiresReference()).toBe(true);
    expect(create().matchesPayload('hash-1')).toBe(true);
    expect(create({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => create({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction transitions', () => {
  test('moves PENDING to PENDING_REFERENCE and then PROCESSED', () => {
    const transaction = create({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'external-reference',
    });
    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    transaction.markProcessed('internal-reference', new Date('2026-01-02T00:00:00.000Z'));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('internal-reference');
    expect(transaction.processedAt).toEqual(new Date('2026-01-02T00:00:00.000Z'));
    expect(transaction.isTerminal()).toBe(true);
  });

  test('allows direct processing for non-reversal transactions', () => {
    const transaction = create({ kind: WagerTransactionKind.Bet });
    transaction.markProcessed(undefined, new Date('2026-01-02T00:00:00.000Z'));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test('rejects invalid transitions and preserves terminal states', () => {
    const pending = create();
    expect(() => pending.markPendingReference()).toThrow(InvalidWagerTransactionError);
    pending.reject(FailureCode.InsufficientBalance);
    expect(pending.status).toBe(WagerTransactionStatus.Rejected);
    expect(pending.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(() => pending.fail(FailureCode.InvalidReference)).toThrow(
      InvalidWagerTransactionStateError,
    );
    expect(() => pending.markProcessed(undefined, new Date())).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  test('supports FAILED as a terminal, auditable state', () => {
    const transaction = create();
    transaction.fail(FailureCode.ReversalInsufficientBalance);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
  });
});

describe('WagerTransaction references and rehydration', () => {
  test('validates same-context references and reversal kinds', () => {
    const bet = create({ externalTransactionId: 'bet-external' });
    bet.markProcessed(undefined, new Date());
    const refund = create({
      id: 'refund',
      externalTransactionId: 'refund-external',
      idempotencyKey: 'refund-key',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-external',
    });
    refund.assertValidReference(bet);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const rollback = create({
      id: 'rollback',
      externalTransactionId: 'rollback-external',
      idempotencyKey: 'rollback-key',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-external',
    });
    rollback.assertValidReference(bet);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test('rejects wrong kind, context, amount and currency references', () => {
    const bet = create({ externalTransactionId: 'bet-external' });
    bet.markProcessed(undefined, new Date());
    const refund = create({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-external',
      money: brl('11.00'),
    });
    expect(() => refund.assertValidReference(bet)).toThrow(InvalidWagerTransactionError);

    const currencyMismatch = create({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-external',
      money: usd('10.00'),
    });
    expect(() => currencyMismatch.assertValidReference(bet)).toThrow(InvalidWagerTransactionError);

    const otherPlayer = create({
      externalTransactionId: 'other-external',
      playerId: 'player-2',
    });
    otherPlayer.markProcessed(undefined, new Date());
    expect(() => refund.assertValidReference(otherPlayer)).toThrow(InvalidWagerTransactionError);
  });

  test('rehydrates state and protects immutable fields and dates', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const processedAt = new Date('2026-01-02T00:00:00.000Z');
    const transaction = WagerTransaction.rehydrate({
      id: 't-1', providerId: 'provider-a', externalTransactionId: 'external-1',
      idempotencyKey: 'key', payloadHash: 'hash', walletId: 'wallet-1', playerId: 'player-1',
      roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Bet, money: brl('2.00'),
      createdAt, status: WagerTransactionStatus.Processed, referenceTransactionId: undefined,
      processedAt,
    });
    const returnedDate = transaction.createdAt;
    returnedDate.setUTCFullYear(2030);
    expect(transaction.createdAt).toEqual(createdAt);
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.id).toBe('t-1');
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });
});
