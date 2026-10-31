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

type HistoricalViolation = {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  currency: string;
  wallet_player_id: string | null;
  wallet_currency: string | null;
  status: string;
};

async function inspectAndSafelyValidateExistingConstraints(admin: Client): Promise<Record<string, unknown>> {
  const tables = await admin.query(`
    SELECT to_regclass('public.wallets') AS wallets,
           to_regclass('public.wager_transactions') AS transactions,
           to_regclass('public.wallet_ledger_entries') AS ledger
  `) as { rows: Array<{ wallets: string | null; transactions: string | null; ledger: string | null }> };
  const present = tables.rows[0] ?? { wallets: null, transactions: null, ledger: null };
  if (!present.wallets || !present.transactions || !present.ledger) return { tables: present, constraints: [], violations: [], validationAction: 'not_applicable' };

  const violations = await admin.query(`
    SELECT t.id::text, t.provider_id, t.external_transaction_id, t.wallet_id::text, t.player_id::text, t.currency,
           w.player_id::text AS wallet_player_id, w.currency AS wallet_currency, t.status
    FROM public.wager_transactions t
    LEFT JOIN public.wallets w ON w.id = t.wallet_id
    WHERE w.id IS NULL OR w.player_id IS DISTINCT FROM t.player_id OR w.currency IS DISTINCT FROM t.currency
    ORDER BY t.created_at, t.id
  `) as { rows: HistoricalViolation[] };
  const ledgerViolations = await admin.query(`
    SELECT l.id::text, l.transaction_id::text AS provider_id, l.wallet_id::text AS external_transaction_id,
           l.wallet_id::text, t.wallet_id::text AS player_id, l.currency,
           NULL::text AS wallet_player_id, NULL::text AS wallet_currency, 'LEDGER_REFERENCE_MISMATCH'::text AS status
    FROM public.wallet_ledger_entries l
    LEFT JOIN public.wager_transactions t ON t.id = l.transaction_id
      AND t.wallet_id = l.wallet_id
    WHERE t.id IS NULL
    ORDER BY l.created_at, l.id
  `) as { rows: HistoricalViolation[] };
  const constraints = await admin.query(`
    SELECT c.conname, c.convalidated
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
      AND c.conname IN ('fk_transactions_wallet_player', 'fk_ledger_transaction_wallet')
    ORDER BY c.conname
  `) as { rows: Array<{ conname: string; convalidated: boolean }> };
  const allViolations = [
    { constraint_name: 'fk_transactions_wallet_player', rows: violations.rows },
    { constraint_name: 'fk_ledger_transaction_wallet', rows: ledgerViolations.rows },
  ];
  const canValidate = constraints.rows.length === 2 && allViolations.every((entry) => entry.rows.length === 0);
  if (canValidate && constraints.rows.some((constraint) => !constraint.convalidated)) {
    await admin.query('ALTER TABLE public.wager_transactions VALIDATE CONSTRAINT fk_transactions_wallet_player');
    await admin.query('ALTER TABLE public.wallet_ledger_entries VALIDATE CONSTRAINT fk_ledger_transaction_wallet');
  }
  return {
    tables: present,
    constraints: constraints.rows,
    violations: allViolations.map((entry) => ({ constraint_name: entry.constraint_name, count: entry.rows.length, records: entry.rows })),
    validationAction: canValidate ? 'validated_or_already_valid' : 'not_executed_due_to_violations_or_missing_constraints',
  };
}

async function main(): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  let dataSource: DataSource | undefined;
  try {
    await admin.connect();
    const existingSchema = await inspectAndSafelyValidateExistingConstraints(admin);
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
    console.log(JSON.stringify({ event: 'migration_cycle_verified', schema, existingSchema, applied: applied.map((migration) => migration.name), isolatedHistoricalFkViolations: violations, validatedConstraints: validated }));
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
