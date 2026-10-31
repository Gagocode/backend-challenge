import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

export function createDatabaseOptions(
  environment: NodeJS.ProcessEnv = process.env,
): DataSourceOptions {
  const url = environment.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is required to configure PostgreSQL');
  }

  const schema = environment.TEST_DATABASE_SCHEMA;
  if (schema !== undefined && !/^[a-z][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error('TEST_DATABASE_SCHEMA must be a safe PostgreSQL schema identifier');
  }

  return {
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    migrationsTableName: 'typeorm_migrations',
    entities: [join(__dirname, '../persistence/typeorm/entities/*{.js,.ts}')],
    migrations: [join(__dirname, 'migrations/*{.js,.ts}')],
    ...(schema ? { extra: { options: `-c search_path=${schema},public` } } : {}),
  };
}
