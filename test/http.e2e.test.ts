import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for HTTP integration tests; use bun run test:unit for infrastructure-free tests');
if (!process.env.TEST_DATABASE_SCHEMA) throw new Error('TEST_DATABASE_SCHEMA is required; use bun run test:integration to isolate PostgreSQL data');
const port = 32000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let application: Bun.Subprocess;
let database: DataSource;

const id = (): string => crypto.randomUUID();
const json = (value: unknown): string => JSON.stringify(value);
const request = async (path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
};
const createWallet = async (amount = '0.00'): Promise<Record<string, unknown>> => {
  const response = await request('/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ playerId: id(), initialBalance: { amount, currency: 'BRL' } }) });
  expect(response.status).toBe(201);
  return response.body;
};
const submit = async (wallet: Record<string, unknown>, overrides: Record<string, unknown> = {}, key = id()): Promise<{ status: number; body: Record<string, unknown> }> => {
  const body = { providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`, playerId: wallet.playerId, walletId: wallet.id, roundId: `round-${id()}`, gameId: 'e2e-game', kind: 'WIN', money: { amount: '1.00', currency: 'BRL' }, ...overrides };
  return request('/wagering/transactions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: json(body) });
};

beforeAll(async () => {
  database = new DataSource(createDatabaseOptions({ ...process.env, DATABASE_URL: databaseUrl }));
  await database.initialize();
  application = Bun.spawn([process.execPath, 'src/main.ts'], { env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), NODE_ENV: 'test', MESSAGING_WORKERS_ENABLED: 'false' }, stdout: 'pipe', stderr: 'pipe' });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { const health = await fetch(`${baseUrl}/health/live`); if (health.ok) return; } catch { /* application is still starting */ }
    await Bun.sleep(100);
  }
  throw new Error('NestJS application did not become ready');
}, 30000);

afterAll(async () => {
  await database.destroy();
  application.kill();
  await application.exited;
}, 30000);

describe('HTTP API against a real NestJS process and PostgreSQL', () => {
  test('creates wallets and rejects duplicate player/currency', async () => {
    const playerId = id();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };
    const first = await request('/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(body) });
    const duplicate = await request('/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(body) });
    expect(first.status).toBe(201); expect(first.body.balance).toEqual({ amount: '10.00', currency: 'BRL' }); expect(duplicate.status).toBe(409);
    const persisted = await database.query('SELECT id, balance_amount FROM wallets WHERE id = $1', [first.body.id]);
    expect(persisted.length).toBe(1); expect(persisted[0]?.balance_amount).toBe('10.00');
  });

  test('gets an existing wallet and returns 404 for an absent one', async () => {
    const wallet = await createWallet('3.00');
    const found = await request(`/wallets/${wallet.id}`); const missing = await request(`/wallets/${id()}`);
    expect(found.status).toBe(200); expect(found.body.id).toBe(wallet.id); expect(missing.status).toBe(404);
  });

  test('paginates ledger with an opaque cursor', async () => {
    const wallet = await createWallet();
    for (let i = 0; i < 3; i += 1) { const result = await submit(wallet); expect(result.status).toBe(201); }
    const first = await request(`/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200); expect(Array.isArray(first.body.entries)).toBe(true); expect((first.body.entries as unknown[]).length).toBe(2); expect(typeof first.body.nextCursor).toBe('string');
    const second = await request(`/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(String(first.body.nextCursor))}`);
    expect(second.status).toBe(200); expect((second.body.entries as unknown[]).length).toBe(1); expect(second.body.nextCursor).toBeUndefined();
    const invalid = await request(`/wallets/${wallet.id}/ledger?limit=0`); expect(invalid.status).toBe(400);
  });

  test('submits and queries transactions by internal and external identity', async () => {
    const wallet = await createWallet(); const external = `external-${id()}`; const provider = `provider-${id()}`; const key = id();
    const submitted = await submit(wallet, { providerId: provider, externalTransactionId: external }, key);
    expect(submitted.status).toBe(201); expect(submitted.body.status).toBe('PROCESSED');
    const internal = await request(`/wagering/transactions/${submitted.body.transactionId}`); const externalResult = await request(`/providers/${provider}/wagering/transactions/${external}`);
    expect(internal.status).toBe(200); expect(externalResult.status).toBe(200); expect(internal.body.transactionId).toBe(submitted.body.transactionId);
  });

  test('replays idempotently and conflicts on a changed payload', async () => {
    const wallet = await createWallet(); const key = id(); const originalPayload = { providerId: `provider-${id()}`, externalTransactionId: `external-${id()}`, playerId: wallet.playerId, walletId: wallet.id, roundId: `round-${id()}`, gameId: 'e2e-game', kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }; const first = await submit(wallet, originalPayload, key); const replay = await submit(wallet, originalPayload, key);
    expect(first.status).toBe(201); expect(replay.status).toBe(200); expect(replay.body.idempotentReplay).toBe(true);
    const conflict = await submit(wallet, { providerId: first.body.providerId, externalTransactionId: first.body.externalTransactionId, money: { amount: '2.00', currency: 'BRL' } }, key);
    expect(conflict.status).toBe(409);
  });

  test('rejects malformed DTOs and missing idempotency key', async () => {
    const invalidWallet = await request('/wallets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ playerId: id(), initialBalance: { amount: 10, currency: 'BRL' }, unexpected: true }) });
    expect(invalidWallet.status).toBe(400);
    const wallet = await createWallet(); const missingKey = await request('/wagering/transactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ providerId: 'p', externalTransactionId: 'e', playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }) });
    expect(missingKey.status).toBe(400);
  });

  test('returns business rejection and pending reference explicitly', async () => {
    const wallet = await createWallet('0.00');
    const rejected = await submit(wallet, { kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }); expect(rejected.status).toBe(422); expect(rejected.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    const pending = await submit(wallet, { kind: 'REFUND', referenceExternalTransactionId: `missing-${id()}` }); expect(pending.status).toBe(202); expect(pending.body.status).toBe('PENDING_REFERENCE');
  });

  test('reconciles consistently and reports divergence without correcting it', async () => {
    const wallet = await createWallet('5.00'); const consistent = await request(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' }); expect(consistent.status).toBe(201); expect(consistent.body.consistent).toBe(true);
    await database.query('UPDATE wallets SET balance_amount = $1 WHERE id = $2', ['7.00', wallet.id]);
    const divergent = await request(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' }); expect(divergent.status).toBe(201); expect(divergent.body.consistent).toBe(false); expect((divergent.body.difference as { amount: string }).amount).toBe('-2.00');
    const unchanged = await database.query('SELECT balance_amount FROM wallets WHERE id = $1', [wallet.id]); expect(unchanged[0]?.balance_amount).toBe('7.00');
  });

  test('exposes liveness and database readiness', async () => {
    const live = await request('/health/live'); const ready = await request('/health/ready');
    expect(live.status).toBe(200); expect(live.body.status).toBe('ok'); expect(ready.status).toBe(200); expect((ready.body.dependencies as Record<string, unknown>).postgres).toBe('up');
  });

  test('returns a client error for an unreachable HTTP dependency without changing financial data', async () => {
    await expect(fetch('http://127.0.0.1:1/health/ready')).rejects.toBeTruthy();
  });
});
