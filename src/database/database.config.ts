import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

export function createDatabaseOptions(
  environment: NodeJS.ProcessEnv = process.env,
): DataSourceOptions {
  const url = environment.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is required to configure PostgreSQL');
  }

  return {
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    migrationsTableName: 'typeorm_migrations',
    migrations: [join(__dirname, 'migrations/*{.js,.ts}')],
  };
}
