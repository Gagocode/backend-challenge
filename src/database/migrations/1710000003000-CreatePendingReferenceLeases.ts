import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePendingReferenceLeases1710000003000 implements MigrationInterface {
  name = 'CreatePendingReferenceLeases1710000003000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wager_transactions
      ADD COLUMN pending_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN pending_next_attempt_at timestamptz,
      ADD COLUMN pending_claimed_at timestamptz,
      ADD COLUMN pending_claim_token uuid,
      ADD COLUMN pending_last_error varchar(2000),
      ADD CONSTRAINT ck_transactions_pending_attempts_non_negative CHECK (pending_attempts >= 0)`);
    await q.query(`CREATE INDEX idx_transactions_pending_claim ON wager_transactions (status, pending_next_attempt_at, pending_claimed_at, created_at, id) WHERE status = 'PENDING_REFERENCE'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS idx_transactions_pending_claim');
    await q.query('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_transactions_pending_attempts_non_negative');
    await q.query(`ALTER TABLE wager_transactions
      DROP COLUMN pending_last_error,
      DROP COLUMN pending_claim_token,
      DROP COLUMN pending_claimed_at,
      DROP COLUMN pending_next_attempt_at,
      DROP COLUMN pending_attempts`);
  }
}
