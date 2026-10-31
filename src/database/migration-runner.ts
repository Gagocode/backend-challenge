import { AppDataSource } from './data-source';

type MigrationCommand = 'run' | 'revert';

async function execute(command: MigrationCommand): Promise<void> {
  try {
    await AppDataSource.initialize();

    if (command === 'run') {
      const migrations = await AppDataSource.runMigrations({ transaction: 'all' });
      console.log(JSON.stringify({ event: 'migrations_applied', migrations: migrations.map(({ name }) => name) }));
    } else {
      await AppDataSource.undoLastMigration({ transaction: 'all' });
      console.log(JSON.stringify({ event: 'migration_reverted' }));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown migration error';
    console.error(JSON.stringify({ event: 'migration_failed', command, message }));
    process.exitCode = 1;
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

async function main(): Promise<void> {
  const command = Bun.argv[2];

  if (command === 'run' || command === 'revert') {
    await execute(command);
    return;
  }

  console.error('Usage: bun run migration:run | bun run migration:revert');
  process.exitCode = 1;
}

void main();
