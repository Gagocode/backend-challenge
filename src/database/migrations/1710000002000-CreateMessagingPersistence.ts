import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessagingPersistence1710000002000 implements MigrationInterface {
  name = 'CreateMessagingPersistence1710000002000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await q.query(`CREATE TABLE outbox_messages (
      id uuid PRIMARY KEY,
      aggregate_id uuid NOT NULL,
      event_type varchar(128) NOT NULL,
      version integer NOT NULL,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL,
      claimed_at timestamptz,
      claim_token uuid,
      published_at timestamptz,
      last_error varchar(2000),
      CONSTRAINT ck_outbox_version_positive CHECK (version > 0),
      CONSTRAINT ck_outbox_attempts_non_negative CHECK (attempts >= 0),
      CONSTRAINT ck_outbox_event_type_non_empty CHECK (length(event_type) > 0)
    )`);
    await q.query(`CREATE INDEX idx_outbox_due ON outbox_messages (published_at, next_attempt_at, claimed_at, occurred_at, id)`);
    await q.query(`CREATE INDEX idx_outbox_event_type ON outbox_messages (event_type, occurred_at, id)`);
    await q.query(`CREATE TABLE inbox_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      consumer_name varchar(128) NOT NULL,
      message_id varchar(255) NOT NULL,
      payload_hash char(64) NOT NULL,
      received_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 1,
      status varchar(16) NOT NULL DEFAULT 'RECEIVED',
      processed_at timestamptz,
      last_error varchar(2000),
      CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id),
      CONSTRAINT ck_inbox_status CHECK (status IN ('RECEIVED','PROCESSED','FAILED')),
      CONSTRAINT ck_inbox_attempts_positive CHECK (attempts > 0),
      CONSTRAINT ck_inbox_payload_hash CHECK (payload_hash ~ '^[0-9a-fA-F]{64}$')
    )`);
    await q.query(`CREATE INDEX idx_inbox_retry ON inbox_messages (consumer_name, status, received_at, id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE inbox_messages');
    await q.query('DROP TABLE outbox_messages');
  }
}
