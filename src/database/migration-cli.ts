import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

async function createMigration(name: string): Promise<void> {
  const className = toPascalCase(name);
  if (!className) {
    throw new Error('Migration name must contain at least one alphanumeric character');
  }

  const timestamp = Date.now();
  const filename = `${timestamp}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ts`;
  const directory = join(__dirname, 'migrations');
  const path = join(directory, filename);
  const content = `import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ${className}${timestamp} implements MigrationInterface {
  name = '${className}${timestamp}';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('');
  }
}
`;

  await mkdir(directory, { recursive: true });
  await Bun.write(path, content);
  console.log(path);
}

async function main(): Promise<void> {
  const name = Bun.argv[3] ?? Bun.argv[2];

  if (!name) {
    console.error('Usage: bun run migration:create -- MigrationName');
    process.exitCode = 1;
    return;
  }

  try {
    await createMigration(name);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Unknown migration creation error');
    process.exitCode = 1;
  }
}

void main();
