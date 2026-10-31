import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { InboxRepository, InboxReceipt, OutboxRepository } from '../../application/ports/messaging-repositories';
import { InboxMessage, InboxMessageStatus } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { IntegrationEvent } from '../../domain/integration-events/integration-events';
import { InboxMessageEntity } from '../typeorm/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../typeorm/entities/outbox-message.entity';

const inboxDomain = (row: InboxMessageEntity): InboxMessage => InboxMessage.rehydrate({
  messageId: row.messageId,
  consumerName: row.consumerName,
  payloadHash: row.payloadHash,
  receivedAt: row.receivedAt,
  attempts: row.attempts,
  status: row.status as InboxMessageStatus,
  ...(row.processedAt ? { processedAt: row.processedAt } : {}),
  ...(row.lastError ? { lastError: row.lastError } : {}),
});

const outboxDomain = (row: OutboxMessageEntity): OutboxMessage => OutboxMessage.rehydrate({
  id: row.id,
  aggregateId: row.aggregateId,
  eventType: row.eventType,
  version: row.version,
  payload: row.payload,
  occurredAt: row.occurredAt,
  createdAt: row.createdAt,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt,
  ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
  ...(row.claimToken ? { claimToken: row.claimToken } : {}),
  ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
  ...(row.lastError ? { lastError: row.lastError } : {}),
});

const returnedRows = <T>(result: unknown): T[] => Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : result as T[];

export class TypeOrmInboxRepository implements InboxRepository {
  public constructor(private readonly manager: EntityManager) {}

  public async receive(messageId: string, consumerName: string, payloadHash: string, receivedAt = new Date()): Promise<InboxReceipt> {
    const repository = this.manager.getRepository(InboxMessageEntity);
    const insertedRows = returnedRows<{ message_id: string }>(await this.manager.query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, attempts, status, processed_at, last_error)
      VALUES ($1, $2, $3, $4, 1, $5, NULL, NULL)
      ON CONFLICT (consumer_name, message_id) DO NOTHING
      RETURNING message_id`, [consumerName, messageId, payloadHash, receivedAt, InboxMessageStatus.Received]));
    const row = await repository.createQueryBuilder('inbox')
      .where('inbox.consumer_name = :consumerName AND inbox.message_id = :messageId', { consumerName, messageId })
      .setLock('pessimistic_write')
      .getOneOrFail();
    if (row.payloadHash !== payloadHash) {
      const message = inboxDomain(row);
      message.markFailed('Message id was reused with a different payload');
      return { message, duplicate: true };
    }
    if (row.status !== InboxMessageStatus.Processed) {
      if (insertedRows.length === 0) row.attempts += 1;
      row.status = InboxMessageStatus.Received;
      await repository.save(row);
    }
    return { message: inboxDomain(row), duplicate: row.status === InboxMessageStatus.Processed };
  }

  public async save(message: InboxMessage): Promise<InboxMessage> {
    const repository = this.manager.getRepository(InboxMessageEntity);
    const row = await repository.findOneByOrFail({ consumerName: message.consumerName, messageId: message.messageId });
    row.attempts = message.attempts;
    row.status = message.status;
    row.processedAt = message.processedAt ?? null;
    row.lastError = message.lastError ?? null;
    return inboxDomain(await repository.save(row));
  }
}

export class TypeOrmOutboxRepository implements OutboxRepository {
  public constructor(private readonly manager: EntityManager) {}

  public async enqueue(event: IntegrationEvent<unknown>): Promise<OutboxMessage> {
    const message = OutboxMessage.enqueue(event);
    const row = this.manager.getRepository(OutboxMessageEntity).create({
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      version: message.version,
      payload: message.payload,
      occurredAt: message.occurredAt,
      createdAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(0),
      claimedAt: null,
      claimToken: null,
      publishedAt: null,
      lastError: null,
    });
    await this.manager.getRepository(OutboxMessageEntity).insert({
      id: row.id, aggregateId: row.aggregateId, eventType: row.eventType, version: row.version, payload: row.payload as never,
      occurredAt: row.occurredAt, createdAt: row.createdAt, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt,
      claimedAt: row.claimedAt, claimToken: row.claimToken, publishedAt: row.publishedAt, lastError: row.lastError,
    });
    return message;
  }

  public async claimDue(limit: number, now: Date, leaseMs: number): Promise<OutboxMessage[]> {
    const claimToken = randomUUID();
    const staleAt = new Date(now.getTime() - leaseMs);
    await this.manager.query(`
      WITH candidates AS (
        SELECT id FROM outbox_messages
        WHERE published_at IS NULL
          AND next_attempt_at <= $1
          AND (claimed_at IS NULL OR claimed_at < $2)
        ORDER BY occurred_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE outbox_messages AS outbox
      SET claimed_at = $1, claim_token = $4, attempts = attempts + 1
      FROM candidates
      WHERE outbox.id = candidates.id`, [now, staleAt, limit, claimToken]);
    const rows = await this.manager.query('SELECT * FROM outbox_messages WHERE claim_token = $1 ORDER BY occurred_at ASC, id ASC', [claimToken]) as Array<Record<string, unknown>>;
    return rows.map((row) => outboxDomain({
      id: String(row.id), aggregateId: String(row.aggregate_id), eventType: String(row.event_type), version: Number(row.version),
      payload: row.payload as Record<string, unknown>, occurredAt: new Date(String(row.occurred_at)), createdAt: new Date(String(row.created_at)),
      attempts: Number(row.attempts), nextAttemptAt: new Date(String(row.next_attempt_at)), claimedAt: now, claimToken,
      publishedAt: row.published_at ? new Date(String(row.published_at)) : null, lastError: row.last_error ? String(row.last_error) : null,
    } as unknown as OutboxMessageEntity));
  }

  public async markPublished(id: string, claimToken: string, at: Date): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(await this.manager.query('UPDATE outbox_messages SET published_at = $1, claimed_at = NULL, claim_token = NULL WHERE id = $2 AND claim_token = $3 AND published_at IS NULL RETURNING id', [at.toISOString(), id, claimToken]));
    return rows.length === 1;
  }

  public async renewClaim(id: string, claimToken: string, now: Date): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(await this.manager.query('UPDATE outbox_messages SET claimed_at = $1 WHERE id = $2 AND claim_token = $3 AND published_at IS NULL RETURNING id', [now.toISOString(), id, claimToken]));
    return rows.length === 1;
  }

  public async scheduleRetry(id: string, claimToken: string, now: Date, error: string, delayMs: number): Promise<boolean> {
    const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 1000;
    const rows = returnedRows<{ id: string }>(await this.manager.query('UPDATE outbox_messages SET next_attempt_at = $1, claimed_at = NULL, claim_token = NULL, last_error = $2 WHERE id = $3 AND claim_token = $4 AND published_at IS NULL RETURNING id', [new Date(now.getTime() + safeDelayMs).toISOString(), error.slice(0, 2000), id, claimToken]));
    return rows.length === 1;
  }
}
