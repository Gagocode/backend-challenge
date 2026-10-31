import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TypeOrmWagerTransactionRepository, TypeOrmWalletLedgerEntryRepository, TypeOrmWalletRepository } from '../persistence/repositories/financial-repositories';
import { WalletLedgerEntryEntity } from '../persistence/typeorm/entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from '../persistence/mappers/financial.mappers';
import { WalletNotFoundError } from '../application/financial-errors';

export interface LedgerPage { entries: ReturnType<typeof WalletLedgerEntryMapper.toDomain>[]; nextCursor?: string }
const encode = (date: Date, id: string): string => Buffer.from(JSON.stringify({ createdAt: date.toISOString(), id }), 'utf8').toString('base64url');
const decode = (cursor: string): { createdAt: string; id: string } => { try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown }; if (typeof value.createdAt !== 'string' || typeof value.id !== 'string' || Number.isNaN(Date.parse(value.createdAt))) throw new Error(); return { createdAt: value.createdAt, id: value.id }; } catch { throw new Error('INVALID_CURSOR'); } };

@Injectable()
export class FinancialQueryService {
  public constructor(private readonly dataSource: DataSource) {}
  public async wallet(id: string) { const wallet = await new TypeOrmWalletRepository(this.dataSource.manager).findById(id); if (!wallet) throw new WalletNotFoundError(id); return wallet; }
  public async transaction(id: string) { return new TypeOrmWagerTransactionRepository(this.dataSource.manager).findById(id); }
  public async externalTransaction(providerId: string, externalId: string) { return new TypeOrmWagerTransactionRepository(this.dataSource.manager).findByProviderAndExternalId(providerId, externalId); }
  public async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const wallet = await this.wallet(walletId); void wallet;
    const q = this.dataSource.getRepository(WalletLedgerEntryEntity).createQueryBuilder('entry').where('entry.wallet_id = :walletId', { walletId }).orderBy('entry.created_at', 'ASC').addOrderBy('entry.id', 'ASC').take(limit + 1);
    if (cursor) { const decoded = decode(cursor); q.andWhere('(entry.created_at > :createdAt OR (entry.created_at = :createdAt AND entry.id > :id))', decoded); }
    const rows = await q.getMany(); const hasMore = rows.length > limit; const pageRows = hasMore ? rows.slice(0, limit) : rows; const entries = pageRows.map(WalletLedgerEntryMapper.toDomain); return { entries, ...(hasMore && pageRows.length ? { nextCursor: encode(pageRows[pageRows.length - 1]!.createdAt, pageRows[pageRows.length - 1]!.id) } : {}) };
  }
}
