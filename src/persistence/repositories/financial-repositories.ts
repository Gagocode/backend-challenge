import type { EntityManager } from 'typeorm';
import type { WagerTransactionRepository, WalletLedgerEntryRepository, WalletRepository } from '../../application/ports/financial-repositories';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WagerTransactionEntity } from '../typeorm/entities/wager-transaction.entity';
import { WalletEntity } from '../typeorm/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../typeorm/entities/wallet-ledger-entry.entity';
import { WagerTransactionMapper, WalletLedgerEntryMapper, WalletMapper } from '../mappers/financial.mappers';

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly manager: EntityManager) {}
  async save(w: Wallet): Promise<Wallet> { return WalletMapper.toDomain(await this.manager.getRepository(WalletEntity).save(WalletMapper.toEntity(w))); }
  async findById(id: string, forUpdate = false): Promise<Wallet | undefined> { const q = this.manager.getRepository(WalletEntity).createQueryBuilder('wallet').where('wallet.id = :id', { id }); if (forUpdate) q.setLock('pessimistic_write'); const row = await q.getOne(); return row ? WalletMapper.toDomain(row) : undefined; }
  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> { const row = await this.manager.getRepository(WalletEntity).findOneBy({ playerId, currency }); return row ? WalletMapper.toDomain(row) : undefined; }
}

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly manager: EntityManager) {}
  async save(t: WagerTransaction): Promise<WagerTransaction> { return WagerTransactionMapper.toDomain(await this.manager.getRepository(WagerTransactionEntity).save(WagerTransactionMapper.toEntity(t))); }
  async findById(id: string): Promise<WagerTransaction | undefined> { const row = await this.manager.getRepository(WagerTransactionEntity).findOneBy({ id }); return row ? WagerTransactionMapper.toDomain(row) : undefined; }
  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> { const row = await this.manager.getRepository(WagerTransactionEntity).findOneBy({ providerId, externalTransactionId }); return row ? WagerTransactionMapper.toDomain(row) : undefined; }
  async findByProviderAndIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> { const row = await this.manager.getRepository(WagerTransactionEntity).findOneBy({ providerId, idempotencyKey }); return row ? WagerTransactionMapper.toDomain(row) : undefined; }
  async findByStatus(status: string): Promise<WagerTransaction[]> { return (await this.manager.getRepository(WagerTransactionEntity).findBy({ status })).map(WagerTransactionMapper.toDomain); }
}

export class TypeOrmWalletLedgerEntryRepository implements WalletLedgerEntryRepository {
  constructor(private readonly manager: EntityManager) {}
  async save(t: WalletLedgerEntry): Promise<WalletLedgerEntry> { const r = this.manager.getRepository(WalletLedgerEntryEntity); await r.insert(WalletLedgerEntryMapper.toEntity(t)); return WalletLedgerEntryMapper.toDomain(await r.findOneByOrFail({ id: t.id })); }
  async findById(id: string): Promise<WalletLedgerEntry | undefined> { const row = await this.manager.getRepository(WalletLedgerEntryEntity).findOneBy({ id }); return row ? WalletLedgerEntryMapper.toDomain(row) : undefined; }
  async findByWalletId(walletId: string): Promise<WalletLedgerEntry[]> { return (await this.manager.getRepository(WalletLedgerEntryEntity).find({ where: { walletId }, order: { createdAt: 'ASC', id: 'ASC' } })).map(WalletLedgerEntryMapper.toDomain); }
  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> { const row = await this.manager.getRepository(WalletLedgerEntryEntity).findOneBy({ transactionId }); return row ? WalletLedgerEntryMapper.toDomain(row) : undefined; }
}
