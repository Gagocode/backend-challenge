import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../money/money';
import type { LedgerDirection } from '../wallet/wallet-ledger-entry';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  public readonly eventId: string;
  public readonly aggregateId: string;
  public readonly correlationId: string;
  public readonly causationId: string | undefined;
  public readonly occurredAt: Date;
  public readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = props.data;
  }

  public toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: string;
}

const transactionData = (transaction: WagerTransaction): WagerTransactionEventData => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  idempotencyKey: transaction.idempotencyKey,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toJSON(),
  status: transaction.status,
  ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
  ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
});

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  public readonly eventType = 'WagerTransactionProcessed';
  public readonly version = 1;

  public static from(transaction: WagerTransaction, context: EventContext, occurredAt: Date): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ eventId: randomUUID(), aggregateId: transaction.id, ...context, occurredAt, data: transactionData(transaction) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  public readonly eventType = 'WagerTransactionRejected';
  public readonly version = 1;

  public static from(transaction: WagerTransaction, context: EventContext, occurredAt: Date): WagerTransactionRejected {
    return new WagerTransactionRejected({ eventId: randomUUID(), aggregateId: transaction.id, ...context, occurredAt, data: transactionData(transaction) });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  public readonly eventType = 'WalletBalanceChanged';
  public readonly version = 1;

  public static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext, occurredAt: Date): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: randomUUID(),
      aggregateId: wallet.id,
      ...context,
      occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  public readonly eventType = 'WagerTransactionPendingReference';
  public readonly version = 1;

  public static from(transaction: WagerTransaction, context: EventContext, occurredAt: Date): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ eventId: randomUUID(), aggregateId: transaction.id, ...context, occurredAt, data: transactionData(transaction) });
  }
}
