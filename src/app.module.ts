import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDatabaseOptions } from './database/database.config';
import { HealthController } from './health.controller';
import { ReadinessController } from './readiness.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { TypeOrmFinancialUnitOfWork } from './persistence/unit-of-work/typeorm-financial-unit-of-work';
import { FinancialQueryService } from './http/financial-query.service';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import type { FinancialUnitOfWork } from './application/ports/financial-repositories';
import { DataSource } from 'typeorm';

export const FINANCIAL_UNIT_OF_WORK = Symbol('FINANCIAL_UNIT_OF_WORK');

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...createDatabaseOptions(),
        retryAttempts: 3,
        retryDelay: 1000,
      }),
    }),
  ],
  controllers: [HealthController, ReadinessController, WalletsController, WageringController],
  providers: [
    { provide: FINANCIAL_UNIT_OF_WORK, useFactory: (dataSource: DataSource): FinancialUnitOfWork => new TypeOrmFinancialUnitOfWork(dataSource), inject: [DataSource] },
    { provide: CreateWalletUseCase, useFactory: (uow: FinancialUnitOfWork) => new CreateWalletUseCase(uow), inject: [FINANCIAL_UNIT_OF_WORK] },
    { provide: ProcessWagerTransactionUseCase, useFactory: (uow: FinancialUnitOfWork) => new ProcessWagerTransactionUseCase(uow), inject: [FINANCIAL_UNIT_OF_WORK] },
    { provide: ReconcileWalletUseCase, useFactory: (uow: FinancialUnitOfWork) => new ReconcileWalletUseCase(uow), inject: [FINANCIAL_UNIT_OF_WORK] },
    FinancialQueryService,
  ],
})
export class AppModule {}
