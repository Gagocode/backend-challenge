import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFinancialPersistence1710000001000 implements MigrationInterface {
  name = 'CreateFinancialPersistence1710000001000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wallets (
      id uuid PRIMARY KEY, player_id uuid NOT NULL, currency char(3) NOT NULL,
      balance_amount numeric(20,2) NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      CONSTRAINT ck_wallets_currency CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT ck_wallets_balance_non_negative CHECK (balance_amount >= 0),
      CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
      CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
      CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
    )`);
    await q.query(`CREATE TABLE wager_transactions (
      id uuid PRIMARY KEY, provider_id varchar(128) NOT NULL, external_transaction_id varchar(255) NOT NULL,
      idempotency_key varchar(255) NOT NULL, payload_hash char(64) NOT NULL, wallet_id uuid NOT NULL,
      player_id uuid NOT NULL, round_id varchar(255) NOT NULL, game_id varchar(255) NOT NULL,
      kind varchar(16) NOT NULL, money_amount numeric(20,2) NOT NULL, currency char(3) NOT NULL,
      reference_external_transaction_id varchar(255), reference_transaction_id uuid,
      status varchar(24) NOT NULL, failure_code varchar(64), created_at timestamptz NOT NULL,
      processed_at timestamptz,
      CONSTRAINT fk_transactions_wallet FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
      CONSTRAINT fk_transactions_reference FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id),
      CONSTRAINT ck_transactions_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      CONSTRAINT ck_transactions_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      CONSTRAINT ck_transactions_currency CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT ck_transactions_payload_hash CHECK (payload_hash ~ '^[0-9a-fA-F]{64}$'),
      CONSTRAINT ck_transactions_non_empty CHECK (length(provider_id) > 0 AND length(external_transaction_id) > 0 AND length(idempotency_key) > 0 AND length(round_id) > 0 AND length(game_id) > 0),
      CONSTRAINT ck_transactions_money_non_negative CHECK (money_amount >= 0),
      CONSTRAINT ck_transactions_reference_required CHECK ((kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL) OR kind NOT IN ('REFUND','ROLLBACK')),
      CONSTRAINT uq_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
      CONSTRAINT uq_transactions_provider_idempotency UNIQUE (provider_id, idempotency_key)
    )`);
    await q.query(`CREATE TABLE wallet_ledger_entries (
      id uuid PRIMARY KEY, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
      direction varchar(6) NOT NULL, money_amount numeric(20,2) NOT NULL,
      balance_before numeric(20,2) NOT NULL, balance_after numeric(20,2) NOT NULL,
      currency char(3) NOT NULL, created_at timestamptz NOT NULL,
      CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
      CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id) REFERENCES wager_transactions(id),
      CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
      CONSTRAINT ck_ledger_currency CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT ck_ledger_amounts_non_negative CHECK (money_amount >= 0 AND balance_before >= 0 AND balance_after >= 0),
      CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id)
    )`);
    await q.query('CREATE INDEX idx_transactions_wallet_status ON wager_transactions (wallet_id, status)');
    await q.query('CREATE INDEX idx_transactions_provider_status ON wager_transactions (provider_id, status)');
    await q.query('CREATE INDEX idx_transactions_reference ON wager_transactions (provider_id, reference_external_transaction_id)');
    await q.query('CREATE INDEX idx_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at, id)');
    await q.query('CREATE INDEX idx_ledger_transaction ON wallet_ledger_entries (transaction_id)');
    await q.query(`CREATE UNIQUE INDEX uq_reversal_once ON wager_transactions (provider_id, reference_external_transaction_id, kind) WHERE kind IN ('REFUND','ROLLBACK')`);
    await q.query(`CREATE FUNCTION validate_ledger_arithmetic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.direction = 'DEBIT' AND NEW.balance_after <> NEW.balance_before - NEW.money_amount THEN RAISE EXCEPTION 'ledger debit arithmetic is invalid'; END IF; IF NEW.direction = 'CREDIT' AND NEW.balance_after <> NEW.balance_before + NEW.money_amount THEN RAISE EXCEPTION 'ledger credit arithmetic is invalid'; END IF; RETURN NEW; END; $$`);
    await q.query(`CREATE TRIGGER wallet_ledger_entries_arithmetic BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION validate_ledger_arithmetic()`);
    await q.query(`CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wallet ledger entries are immutable'; END; $$`);
    await q.query(`CREATE TRIGGER wallet_ledger_entries_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries');
    await q.query('DROP TRIGGER IF EXISTS wallet_ledger_entries_arithmetic ON wallet_ledger_entries');
    await q.query('DROP FUNCTION IF EXISTS validate_ledger_arithmetic()');
    await q.query('DROP FUNCTION IF EXISTS reject_ledger_mutation()');
    await q.query('DROP TABLE wallet_ledger_entries');
    await q.query('DROP TABLE wager_transactions');
    await q.query('DROP TABLE wallets');
  }
}
