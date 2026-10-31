import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StrengthenFinancialAssociations1710000004000 implements MigrationInterface {
  name = 'StrengthenFinancialAssociations1710000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallets
      ADD CONSTRAINT uq_wallets_id_player_currency UNIQUE (id, player_id, currency)
    `);
    await queryRunner.query(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT uq_transactions_id_wallet UNIQUE (id, wallet_id)
    `);
    await queryRunner.query(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT fk_transactions_wallet_player
      FOREIGN KEY (wallet_id, player_id, currency)
      REFERENCES wallets (id, player_id, currency)
      NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT fk_ledger_transaction_wallet
      FOREIGN KEY (transaction_id, wallet_id)
      REFERENCES wager_transactions (id, wallet_id)
      NOT VALID
    `);
    await queryRunner.query('ALTER TABLE wager_transactions VALIDATE CONSTRAINT fk_transactions_wallet_player');
    await queryRunner.query('ALTER TABLE wallet_ledger_entries VALIDATE CONSTRAINT fk_ledger_transaction_wallet');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT fk_ledger_transaction_wallet');
    await queryRunner.query('ALTER TABLE wager_transactions DROP CONSTRAINT fk_transactions_wallet_player');
    await queryRunner.query('ALTER TABLE wager_transactions DROP CONSTRAINT uq_transactions_id_wallet');
    await queryRunner.query('ALTER TABLE wallets DROP CONSTRAINT uq_wallets_id_player_currency');
  }
}
