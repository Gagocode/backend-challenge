import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { FinancialUnitOfWork } from '../application/ports/financial-repositories';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction/wager-transaction';
import { DataSource } from 'typeorm';
import { Money } from '../domain/money/money';
import { TypeOrmWagerTransactionRepository } from '../persistence/repositories/financial-repositories';
import { MetricsService } from '../observability/metrics.service';
import { StructuredLogger, safeCorrelationId } from '../observability/structured-logger';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private processingPromise?: Promise<void>;

  public constructor(private readonly dataSource: DataSource, private readonly unitOfWork: FinancialUnitOfWork, private readonly process: ProcessWagerTransactionUseCase, private readonly logger = new StructuredLogger(), private readonly metrics = new MetricsService()) {}

  public onModuleInit(): void {
    this.running = true;
    this.timer = setInterval(() => {
      void this.processPending().catch((error: unknown) => this.logger.error('pending_reference_worker_failed', { component: 'pending_reference', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' }));
    }, Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 1000));
  }

  public async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    await this.processingPromise;
  }

  public async processPending(): Promise<void> {
    if (!this.running || this.processingPromise) return;
    this.processingPromise = this.processClaimedPending();
    try {
      await this.processingPromise;
    } finally {
      this.processingPromise = undefined;
    }
  }

  private async processClaimedPending(): Promise<void> {
    const now = new Date();
    const leaseMs = Number(process.env.PENDING_REFERENCE_LEASE_MS ?? 30000);
    const retryBaseMs = Number(process.env.PENDING_REFERENCE_RETRY_BASE_MS ?? 1000);
    const retryMaxMs = Number(process.env.PENDING_REFERENCE_RETRY_MAX_MS ?? 60000);
    const claims = await this.dataSource.transaction(async (manager) => new TypeOrmWagerTransactionRepository(manager).claimPendingReferences(25, now, leaseMs));
    for (const claim of claims) {
      if (!this.running) break;
      const transaction = claim.transaction;
      const correlationId = safeCorrelationId(transaction.idempotencyKey, transaction.id);
      this.logger.info('pending_reference_received', { correlationId, transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId, attempt: claim.attempts, component: 'pending_reference' });
      try {
        const ttlMs = Number(process.env.PENDING_REFERENCE_TTL_MS ?? 15 * 60 * 1000);
        const result = await this.process.execute({
          id: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          payloadHash: transaction.payloadHash,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
          money: Money.from(transaction.money.toJSON()),
          ...(transaction.referenceExternalTransactionId ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId } : {}),
          correlationId,
          source: 'pending_reference',
          ...(Date.now() - transaction.createdAt.getTime() >= ttlMs ? { expirePendingReference: true } : {}),
        });
        if (result.transaction.status === WagerTransactionStatus.PendingReference) {
          const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(claim.attempts - 1, 10)));
          await this.dataSource.transaction(async (manager) => new TypeOrmWagerTransactionRepository(manager).schedulePendingReferenceRetry(transaction.id, claim.claimToken, new Date(), 'reference still absent', delayMs));
          this.metrics.retry('pending_reference', 'business');
          this.logger.warn('pending_reference_retry_scheduled', { correlationId, transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId, attempt: claim.attempts, delayMs, component: 'pending_reference', reason: 'reference_missing' });
        }
      } catch (error: unknown) {
        const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(claim.attempts - 1, 10)));
        await this.dataSource.transaction(async (manager) => new TypeOrmWagerTransactionRepository(manager).schedulePendingReferenceRetry(transaction.id, claim.claimToken, new Date(), error instanceof Error ? error.message : 'Pending reference retry failed', delayMs));
        this.metrics.retry('pending_reference', 'infrastructure');
        this.logger.error('pending_reference_retry_failed', { correlationId, transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId, attempt: claim.attempts, delayMs, component: 'pending_reference', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' });
      }
    }
  }
}
