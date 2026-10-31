import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../src/domain/money/money';
import { WagerTransaction, WagerTransactionKind } from '../src/domain/wager-transaction/wager-transaction';
import { WagerTransactionProcessed } from '../src/domain/integration-events/integration-events';

describe('integration events', () => {
  test('serializes a stable versioned envelope and MoneyProps', () => {
    const transaction = WagerTransaction.create({
      id: randomUUID(), providerId: 'provider-a', externalTransactionId: 'external-1', idempotencyKey: 'key-1', payloadHash: 'a'.repeat(64),
      walletId: randomUUID(), playerId: randomUUID(), roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    transaction.markProcessed(undefined, new Date('2026-10-30T21:00:00.000Z'));
    const event = WagerTransactionProcessed.from(transaction, { correlationId: 'correlation-1' }, new Date('2026-10-30T21:00:00.000Z'));
    const json = event.toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect((json.data as { money: { amount: string } }).money.amount).toBe('25.00');
    expect(JSON.stringify(json)).not.toContain('bigint');
  });
});
