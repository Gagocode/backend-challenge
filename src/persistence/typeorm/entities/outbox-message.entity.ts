import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'outbox_messages' })
@Index('idx_outbox_due', ['publishedAt', 'nextAttemptAt', 'claimedAt', 'occurredAt'])
@Index('idx_outbox_event_type', ['eventType', 'occurredAt'])
export class OutboxMessageEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
  @Column({ name: 'event_type', type: 'varchar', length: 128 }) eventType!: string;
  @Column({ type: 'integer' }) version!: number;
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt!: Date;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ type: 'integer', default: 0 }) attempts!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz' }) nextAttemptAt!: Date;
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true }) claimedAt!: Date | null;
  @Column({ name: 'claim_token', type: 'uuid', nullable: true }) claimToken!: string | null;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt!: Date | null;
  @Column({ name: 'last_error', type: 'varchar', length: 2000, nullable: true }) lastError!: string | null;
}
