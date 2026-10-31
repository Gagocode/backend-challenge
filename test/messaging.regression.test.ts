import { describe, expect, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { InboxMessage } from '../src/domain/messaging/inbox-message';
import { hashWagerTransactionPayload } from '../src/application/messaging/payload-hash';
import { WagerTransactionConsumer } from '../src/messaging/sqs/wager-transaction.consumer';
import type { SqsClientService } from '../src/messaging/sqs/sqs-client';

const sqsStub = (overrides: Record<string, unknown> = {}): SqsClientService => ({
  enabled: true,
  consumerName: 'regression-consumer',
  visibilityTimeoutSeconds: 30,
  outputQueue: 'wager-integration-events.fifo',
  receive: async () => [],
  delete: async () => undefined,
  retry: async () => undefined,
  sendToDlq: async () => undefined,
  send: async () => undefined,
  check: async () => undefined,
  queueUrl: async () => 'http://localhost/queue',
  ...overrides,
} as unknown as SqsClientService);

const uowStub = () => ({
  execute: async <T>(work: (context: Record<string, unknown>) => Promise<T>): Promise<T> => work({
    inbox: {
      receive: async (messageId: string, consumerName: string, payloadHash: string) => ({ message: InboxMessage.receive({ messageId, consumerName, payloadHash, receivedAt: new Date() }), duplicate: false }),
      save: async (message: InboxMessage) => message,
    },
    outbox: {},
  }),
});

const message = (body: unknown): Message => ({ Body: JSON.stringify(body), MessageId: 'sqs-id', ReceiptHandle: 'receipt' });

describe('messaging regressions', () => {
  test('transport message id does not change the financial payload hash', () => {
    const data = { providerId: 'provider-a', externalTransactionId: 'external-1', idempotencyKey: 'provider-a:external-1', playerId: 'player-1', walletId: 'wallet-1', roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } };
    expect(hashWagerTransactionPayload(data)).toBe(hashWagerTransactionPayload({ ...data, messageId: 'another-message', occurredAt: new Date().toISOString() }));
    expect(hashWagerTransactionPayload(data)).toBe(hashWagerTransactionPayload({ ...data, money: { amount: '10.0', currency: 'BRL' } }));
    expect(hashWagerTransactionPayload(data)).not.toBe(hashWagerTransactionPayload({ ...data, money: { amount: '11.00', currency: 'BRL' } }));
  });

  test('integration events arriving on the input queue are routed to DLQ, never silently ACKed', async () => {
    const calls: string[] = [];
    const sqs = sqsStub({ sendToDlq: async () => { calls.push('dlq'); }, delete: async () => { calls.push('delete'); } });
    const process = { execute: async () => { throw new Error('financial processing must not run'); } };
    const consumer = new WagerTransactionConsumer(sqs, uowStub() as never, process as never);
    await consumer.processMessage(message({ eventId: 'event-1', eventType: 'WalletBalanceChanged', version: 1, aggregateId: 'wallet-1', correlationId: 'correlation-1', occurredAt: new Date().toISOString(), data: {} }));
    expect(calls).toEqual(['dlq', 'delete']);
  });

  test('SIGTERM shutdown stops polling through the abort signal and does not ACK', async () => {
    let aborted = false;
    const sqs = sqsStub({
      receive: (signal?: AbortSignal) => new Promise<Message[]>((_, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      }),
    });
    const consumer = new WagerTransactionConsumer(sqs, uowStub() as never, { execute: async () => { throw new Error('not called'); } } as never);
    consumer.onModuleInit();
    await consumer.onModuleDestroy();
    expect(aborted).toBe(true);
  });
});
