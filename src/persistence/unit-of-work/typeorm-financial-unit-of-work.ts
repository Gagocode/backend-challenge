import { DataSource } from 'typeorm';
import type { FinancialTransactionContext, FinancialUnitOfWork } from '../../application/ports/financial-repositories';
import { TypeOrmWagerTransactionRepository, TypeOrmWalletLedgerEntryRepository, TypeOrmWalletRepository } from '../repositories/financial-repositories';
import { TypeOrmInboxRepository, TypeOrmOutboxRepository } from '../repositories/messaging-repositories';

export class TypeOrmFinancialUnitOfWork implements FinancialUnitOfWork {
  public constructor(private readonly dataSource: DataSource) {}

  public execute<T>(work: (context: FinancialTransactionContext) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => work({
      wallets: new TypeOrmWalletRepository(manager),
      transactions: new TypeOrmWagerTransactionRepository(manager),
      ledger: new TypeOrmWalletLedgerEntryRepository(manager),
      inbox: new TypeOrmInboxRepository(manager),
      outbox: new TypeOrmOutboxRepository(manager),
    }));
  }
}
