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
import { SqsClientService } from './messaging/sqs/sqs-client';
import { OutboxPublisher } from './messaging/sqs/outbox.publisher';
import { WagerTransactionConsumer } from './messaging/sqs/wager-transaction.consumer';
import { PendingReferenceWorker } from './messaging/pending-reference.worker';

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
    SqsClientService,
    { provide: OutboxPublisher, useFactory: (dataSource: DataSource, sqs: SqsClientService) => new OutboxPublisher(dataSource, sqs), inject: [DataSource, SqsClientService] },
    { provide: WagerTransactionConsumer, useFactory: (sqs: SqsClientService, uow: FinancialUnitOfWork, process: ProcessWagerTransactionUseCase) => new WagerTransactionConsumer(sqs, uow, process), inject: [SqsClientService, FINANCIAL_UNIT_OF_WORK, ProcessWagerTransactionUseCase] },
    { provide: PendingReferenceWorker, useFactory: (dataSource: DataSource, uow: FinancialUnitOfWork, process: ProcessWagerTransactionUseCase) => new PendingReferenceWorker(dataSource, uow, process), inject: [DataSource, FINANCIAL_UNIT_OF_WORK, ProcessWagerTransactionUseCase] },
  ],
})
export class AppModule {}
