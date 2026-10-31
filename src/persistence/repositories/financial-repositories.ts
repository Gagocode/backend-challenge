import type { EntityManager } from 'typeorm';
import type { WagerTransactionRepository, WalletLedgerEntryRepository, WalletRepository } from '../../application/ports/financial-repositories';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WagerTransactionEntity } from '../typeorm/entities/wager-transaction.entity';
import { WalletEntity } from '../typeorm/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../typeorm/entities/wallet-ledger-entry.entity';
import { WagerTransactionMapper, WalletLedgerEntryMapper, WalletMapper } from '../mappers/financial.mappers';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction';
import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';

const returnedRows = <T>(result: unknown): T[] => Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : result as T[];

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly manager: EntityManager) {}
  async save(w: Wallet): Promise<Wallet> { return WalletMapper.toDomain(await this.manager.getRepository(WalletEntity).save(WalletMapper.toEntity(w))); }
  async findById(id: string, forUpdate = false): Promise<Wallet | undefined> { const q = this.manager.getRepository(WalletEntity).createQueryBuilder('wallet').where('wallet.id = :id', { id }); if (forUpdate) q.setLock('pessimistic_write'); const row = await q.getOne(); return row ? WalletMapper.toDomain(row) : undefined; }
  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> { const row = await this.manager.getRepository(WalletEntity).findOneBy({ playerId, currency }); return row ? WalletMapper.toDomain(row) : undefined; }
}

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly manager: EntityManager) {}
  async save(t: WagerTransaction): Promise<WagerTransaction> { const repository = this.manager.getRepository(WagerTransactionEntity); const current = await repository.findOneBy({ id: t.id }); const entity = WagerTransactionMapper.toEntity(t); entity.pendingAttempts = current?.pendingAttempts ?? 0; entity.pendingNextAttemptAt = null; entity.pendingClaimedAt = null; entity.pendingClaimToken = null; entity.pendingLastError = null; return WagerTransactionMapper.toDomain(await repository.save(entity)); }
  async findById(id: string): Promise<WagerTransaction | undefined> { const row = await this.manager.getRepository(WagerTransactionEntity).findOneBy({ id }); return row ? WagerTransactionMapper.toDomain(row) : undefined; }
  async findByProviderAndExternalId(providerId: string, externalTransactionId: string, forUpdate = false): Promise<WagerTransaction | undefined> { const q = this.manager.getRepository(WagerTransactionEntity).createQueryBuilder('transaction').where('transaction.provider_id = :providerId AND transaction.external_transaction_id = :externalTransactionId', { providerId, externalTransactionId }); if (forUpdate) q.setLock('pessimistic_write'); const row = await q.getOne(); return row ? WagerTransactionMapper.toDomain(row) : undefined; }
  async findByProviderAndIdempotencyKey(providerId: string, idempotencyKey: string, forUpdate = false): Promise<WagerTransaction | undefined> { const q = this.manager.getRepository(WagerTransactionEntity).createQueryBuilder('transaction').where('transaction.provider_id = :providerId AND transaction.idempotency_key = :idempotencyKey', { providerId, idempotencyKey }); if (forUpdate) q.setLock('pessimistic_write'); const row = await q.getOne(); return row ? WagerTransactionMapper.toDomain(row) : undefined; }
  async findByStatus(status: string): Promise<WagerTransaction[]> { return (await this.manager.getRepository(WagerTransactionEntity).findBy({ status })).map(WagerTransactionMapper.toDomain); }
  async claimPendingReferences(limit: number, now: Date, leaseMs: number) {
    const claimToken = randomUUID();
    const staleAt = new Date(now.getTime() - leaseMs);
    const rows = returnedRows<{ id: string }>(await this.manager.query(`
      WITH candidates AS (
        SELECT id FROM wager_transactions
        WHERE status = $1
          AND (pending_next_attempt_at IS NULL OR pending_next_attempt_at <= $2)
          AND (pending_claimed_at IS NULL OR pending_claimed_at < $3)
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $4
      )
      UPDATE wager_transactions AS transaction
      SET pending_claimed_at = $2, pending_claim_token = $5, pending_attempts = transaction.pending_attempts + 1
      FROM candidates
      WHERE transaction.id = candidates.id
      RETURNING transaction.id`, [WagerTransactionStatus.PendingReference, now, staleAt, limit, claimToken]));
    const entities = rows.length ? await this.manager.getRepository(WagerTransactionEntity).findBy({ id: In(rows.map((row) => row.id)) }) : [];
    return entities.map((entity) => ({ transaction: WagerTransactionMapper.toDomain(entity), claimToken, attempts: entity.pendingAttempts }));
  }
  async schedulePendingReferenceRetry(id: string, claimToken: string, now: Date, error: string, delayMs: number): Promise<boolean> { const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 1000; const rows = returnedRows<{ id: string }>(await this.manager.query('UPDATE wager_transactions SET pending_next_attempt_at = $1, pending_claimed_at = NULL, pending_claim_token = NULL, pending_last_error = $2 WHERE id = $3 AND status = $4 AND pending_claim_token = $5 RETURNING id', [new Date(now.getTime() + safeDelayMs).toISOString(), error.slice(0, 2000), id, WagerTransactionStatus.PendingReference, claimToken])); return rows.length === 1; }
}

export class TypeOrmWalletLedgerEntryRepository implements WalletLedgerEntryRepository {
  constructor(private readonly manager: EntityManager) {}
  async save(t: WalletLedgerEntry): Promise<WalletLedgerEntry> { const r = this.manager.getRepository(WalletLedgerEntryEntity); await r.insert(WalletLedgerEntryMapper.toEntity(t)); return WalletLedgerEntryMapper.toDomain(await r.findOneByOrFail({ id: t.id })); }
  async findById(id: string): Promise<WalletLedgerEntry | undefined> { const row = await this.manager.getRepository(WalletLedgerEntryEntity).findOneBy({ id }); return row ? WalletLedgerEntryMapper.toDomain(row) : undefined; }
  async findByWalletId(walletId: string): Promise<WalletLedgerEntry[]> { return (await this.manager.getRepository(WalletLedgerEntryEntity).find({ where: { walletId }, order: { createdAt: 'ASC', id: 'ASC' } })).map(WalletLedgerEntryMapper.toDomain); }
  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> { const row = await this.manager.getRepository(WalletLedgerEntryEntity).findOneBy({ transactionId }); return row ? WalletLedgerEntryMapper.toDomain(row) : undefined; }
}
