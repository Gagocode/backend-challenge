import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { IntegrationEvent } from '../../domain/integration-events/integration-events';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';

export interface InboxReceipt {
  message: InboxMessage;
  duplicate: boolean;
}

export interface InboxRepository {
  receive(messageId: string, consumerName: string, payloadHash: string, receivedAt?: Date): Promise<InboxReceipt>;
  save(message: InboxMessage): Promise<InboxMessage>;
}

export interface OutboxRepository {
  enqueue(event: IntegrationEvent<unknown>): Promise<OutboxMessage>;
  claimDue(limit: number, now: Date, leaseMs: number): Promise<OutboxMessage[]>;
  renewClaim(id: string, claimToken: string, now: Date): Promise<boolean>;
  markPublished(id: string, claimToken: string, at: Date): Promise<boolean>;
  scheduleRetry(id: string, claimToken: string, now: Date, error: string, delayMs: number): Promise<boolean>;
}

export interface PendingReferenceClaim {
  transaction: WagerTransaction;
  claimToken: string;
  attempts: number;
}

