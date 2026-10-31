import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'inbox_messages' })
@Unique('uq_inbox_consumer_message', ['consumerName', 'messageId'])
@Index('idx_inbox_retry', ['consumerName', 'status', 'receivedAt'])
export class InboxMessageEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'consumer_name', type: 'varchar', length: 128 }) consumerName!: string;
  @Column({ name: 'message_id', type: 'varchar', length: 255 }) messageId!: string;
  @Column({ name: 'payload_hash', type: 'char', length: 64 }) payloadHash!: string;
  @Column({ name: 'received_at', type: 'timestamptz' }) receivedAt!: Date;
  @Column({ type: 'integer', default: 1 }) attempts!: number;
  @Column({ type: 'varchar', length: 16, default: 'RECEIVED' }) status!: string;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt!: Date | null;
  @Column({ name: 'last_error', type: 'varchar', length: 2000, nullable: true }) lastError!: string | null;
}
