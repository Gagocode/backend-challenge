import { describe, expect, test } from 'bun:test';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { createDatabaseOptions } from '../src/database/database.config';

describe('createDatabaseOptions', () => {
  test('configures PostgreSQL without automatic schema synchronization', () => {
    const options = createDatabaseOptions({
      DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
    }) as PostgresConnectionOptions;

    expect(options.type).toBe('postgres');
    expect(options.url).toBe('postgresql://user:password@localhost:5432/database');
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
    expect(options.migrations).toHaveLength(1);
  });

  test('requires a database URL', () => {
    expect(() => createDatabaseOptions({})).toThrow('DATABASE_URL is required');
  });
});
