import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Migration verification requires DATABASE_URL.');
  process.exit(1);
}

const schema = `migration_it_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function main(): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  let dataSource: DataSource | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.end();

    dataSource = new DataSource(createDatabaseOptions({ ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_SCHEMA: schema }));
    await dataSource.initialize();
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    if (applied.length !== 5) throw new Error(`Expected 5 migrations to apply, got ${applied.length}`);

    for (let index = 0; index < applied.length; index += 1) await dataSource.undoLastMigration({ transaction: 'all' });
    const afterRevert = await dataSource.query('SELECT to_regclass($1) AS wallets, to_regclass($2) AS transactions', [`${schema}.wallets`, `${schema}.wager_transactions`]);
    if (afterRevert[0]?.wallets !== null || afterRevert[0]?.transactions !== null) throw new Error('Migration revert left financial tables behind');

    const reapplied = await dataSource.runMigrations({ transaction: 'all' });
    if (reapplied.length !== 5) throw new Error(`Expected 5 migrations to reapply, got ${reapplied.length}`);
    const afterReapply = await dataSource.query('SELECT to_regclass($1) AS wallets, to_regclass($2) AS transactions, to_regclass($3) AS ledger', [`${schema}.wallets`, `${schema}.wager_transactions`, `${schema}.wallet_ledger_entries`]);
    if (!afterReapply[0]?.wallets || !afterReapply[0]?.transactions || !afterReapply[0]?.ledger) throw new Error('Migration reapply did not restore financial tables');
    const violations = await dataSource.query(`
      SELECT 'fk_transactions_wallet_player' AS constraint_name, count(*)::int AS count
      FROM wager_transactions transaction
      LEFT JOIN wallets wallet ON wallet.id = transaction.wallet_id AND wallet.player_id = transaction.player_id AND wallet.currency = transaction.currency
      WHERE wallet.id IS NULL
      UNION ALL
      SELECT 'fk_ledger_transaction_wallet' AS constraint_name, count(*)::int AS count
      FROM wallet_ledger_entries ledger
      LEFT JOIN wager_transactions transaction ON transaction.id = ledger.transaction_id AND transaction.wallet_id = ledger.wallet_id
      WHERE transaction.id IS NULL
    `) as Array<{ constraint_name: string; count: number }>;
    if (violations.some((row) => Number(row.count) > 0)) throw new Error(`Historical FK violations found: ${JSON.stringify(violations)}`);
    const validated = await dataSource.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('fk_transactions_wallet_player', 'fk_ledger_transaction_wallet') ORDER BY conname`) as Array<{ conname: string; convalidated: boolean }>;
    if (validated.length !== 2 || validated.some((row) => !row.convalidated)) throw new Error(`Strengthened constraints are not validated: ${JSON.stringify(validated)}`);
    console.log(JSON.stringify({ event: 'migration_cycle_verified', schema, applied: applied.map((migration) => migration.name), historicalFkViolations: violations, validatedConstraints: validated }));
  } finally {
    if (dataSource?.isInitialized) await dataSource.destroy();
    try {
      const cleanup = new Client({ connectionString: databaseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await cleanup.end();
    } catch (error: unknown) {
      console.error(`Could not clean migration schema ${schema}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await main();
