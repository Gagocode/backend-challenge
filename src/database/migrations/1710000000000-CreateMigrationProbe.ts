import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMigrationProbe1710000000000 implements MigrationInterface {
  name = 'CreateMigrationProbe1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE migration_probe (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE migration_probe');
  }
}
