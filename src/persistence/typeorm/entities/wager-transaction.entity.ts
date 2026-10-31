import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wager_transactions' })
@Index('uq_wager_transactions_provider_external', ['providerId', 'externalTransactionId'], { unique: true })
@Index('uq_wager_transactions_provider_idempotency', ['providerId', 'idempotencyKey'], { unique: true })
@Index('idx_wager_transactions_wallet_status', ['walletId', 'status'])
@Index('idx_wager_transactions_provider_status', ['providerId', 'status'])
export class WagerTransactionEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'provider_id', type: 'varchar', length: 128 }) providerId!: string;
  @Column({ name: 'external_transaction_id', type: 'varchar', length: 255 }) externalTransactionId!: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 }) idempotencyKey!: string;
  @Column({ name: 'payload_hash', type: 'char', length: 64 }) payloadHash!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'player_id', type: 'uuid' }) playerId!: string;
  @Column({ name: 'round_id', type: 'varchar', length: 255 }) roundId!: string;
  @Column({ name: 'game_id', type: 'varchar', length: 255 }) gameId!: string;
  @Column({ type: 'varchar', length: 16 }) kind!: string;
  @Column({ name: 'money_amount', type: 'numeric', precision: 20, scale: 2 }) moneyAmount!: string;
  @Column({ name: 'currency', type: 'char', length: 3 }) currency!: string;
  @Column({ name: 'reference_external_transaction_id', type: 'varchar', length: 255, nullable: true }) referenceExternalTransactionId!: string | null;
  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true }) referenceTransactionId!: string | null;
  @Column({ type: 'varchar', length: 24 }) status!: string;
  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true }) failureCode!: string | null;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt!: Date | null;
  @Column({ name: 'pending_attempts', type: 'integer', default: 0 }) pendingAttempts!: number;
  @Column({ name: 'pending_next_attempt_at', type: 'timestamptz', nullable: true }) pendingNextAttemptAt!: Date | null;
  @Column({ name: 'pending_claimed_at', type: 'timestamptz', nullable: true }) pendingClaimedAt!: Date | null;
  @Column({ name: 'pending_claim_token', type: 'uuid', nullable: true }) pendingClaimToken!: string | null;
  @Column({ name: 'pending_last_error', type: 'varchar', length: 2000, nullable: true }) pendingLastError!: string | null;
}
