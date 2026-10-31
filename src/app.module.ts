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
import { StructuredLogger } from './observability/structured-logger';
import { MetricsController } from './observability/metrics.controller';
import { MetricsService } from './observability/metrics.service';

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
  controllers: [HealthController, ReadinessController, WalletsController, WageringController, MetricsController],
  providers: [
    { provide: StructuredLogger, useFactory: () => new StructuredLogger() },
    MetricsService,
    { provide: FINANCIAL_UNIT_OF_WORK, useFactory: (dataSource: DataSource): FinancialUnitOfWork => new TypeOrmFinancialUnitOfWork(dataSource), inject: [DataSource] },
    { provide: CreateWalletUseCase, useFactory: (uow: FinancialUnitOfWork, logger: StructuredLogger) => new CreateWalletUseCase(uow, logger), inject: [FINANCIAL_UNIT_OF_WORK, StructuredLogger] },
    { provide: ProcessWagerTransactionUseCase, useFactory: (uow: FinancialUnitOfWork, logger: StructuredLogger, metrics: MetricsService) => new ProcessWagerTransactionUseCase(uow, logger, metrics), inject: [FINANCIAL_UNIT_OF_WORK, StructuredLogger, MetricsService] },
    { provide: ReconcileWalletUseCase, useFactory: (uow: FinancialUnitOfWork, logger: StructuredLogger, metrics: MetricsService) => new ReconcileWalletUseCase(uow, logger, metrics), inject: [FINANCIAL_UNIT_OF_WORK, StructuredLogger, MetricsService] },
    FinancialQueryService,
    SqsClientService,
    { provide: OutboxPublisher, useFactory: (dataSource: DataSource, sqs: SqsClientService, logger: StructuredLogger, metrics: MetricsService) => new OutboxPublisher(dataSource, sqs, logger, metrics), inject: [DataSource, SqsClientService, StructuredLogger, MetricsService] },
    { provide: WagerTransactionConsumer, useFactory: (sqs: SqsClientService, uow: FinancialUnitOfWork, process: ProcessWagerTransactionUseCase, logger: StructuredLogger, metrics: MetricsService) => new WagerTransactionConsumer(sqs, uow, process, logger, metrics), inject: [SqsClientService, FINANCIAL_UNIT_OF_WORK, ProcessWagerTransactionUseCase, StructuredLogger, MetricsService] },
    { provide: PendingReferenceWorker, useFactory: (dataSource: DataSource, uow: FinancialUnitOfWork, process: ProcessWagerTransactionUseCase, logger: StructuredLogger, metrics: MetricsService) => new PendingReferenceWorker(dataSource, uow, process, logger, metrics), inject: [DataSource, FINANCIAL_UNIT_OF_WORK, ProcessWagerTransactionUseCase, StructuredLogger, MetricsService] },
  ],
})
export class AppModule {}
