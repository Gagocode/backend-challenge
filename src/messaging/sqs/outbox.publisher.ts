import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TypeOrmOutboxRepository } from '../../persistence/repositories/messaging-repositories';
import { SqsClientService } from './sqs-client';
import { MetricsService } from '../../observability/metrics.service';
import { StructuredLogger } from '../../observability/structured-logger';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private polling?: Promise<void>;
  private crashFaultInjected = false;

  public constructor(private readonly dataSource: DataSource, private readonly sqs: SqsClientService, private readonly logger = new StructuredLogger(), private readonly metrics = new MetricsService()) {}

  public onModuleInit(): void {
    if (this.sqs.enabled) {
      this.running = true;
      this.polling = this.poll();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.polling;
  }

  public async publishBatch(): Promise<number> {
    const now = new Date();
    const leaseMs = Number(process.env.OUTBOX_LEASE_MS ?? 30000);
    const batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 10);
    const claimed = await this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).claimDue(batchSize, now, leaseMs));
    if (claimed.length === 0) this.metrics.outboxLag(0);
    for (const message of claimed) this.metrics.outboxLag(Math.max(0, now.getTime() - message.occurredAt.getTime()));
    let published = 0;
    for (const message of claimed) {
      const token = message.claimToken;
      if (!token) continue;
      let leaseLost = false;
      const renewalInterval = setInterval(() => {
        void this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).renewClaim(message.id, token, new Date())).then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            this.logger.error('outbox_lease_lost', { eventId: message.id, aggregateId: message.aggregateId, component: 'outbox_publisher' });
          }
        }).catch((error: unknown) => {
          this.logger.error('outbox_lease_renewal_failed', { eventId: message.id, aggregateId: message.aggregateId, component: 'outbox_publisher', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' });
        });
      }, Math.max(250, Math.floor(leaseMs / 3)));
      try {
        await this.sqs.send(JSON.stringify(message.payload), message.aggregateId, message.id);
        if (this.shouldCrashAfterSend()) process.exit(43);
        const acknowledged = !leaseLost && await this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).markPublished(message.id, token, new Date()));
        if (acknowledged) published += 1;
      } catch (error: unknown) {
        const delayMs = Math.min(60000, 1000 * (2 ** Math.min(message.attempts - 1, 6)));
        await this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).scheduleRetry(message.id, token, new Date(), error instanceof Error ? error.message : 'SQS publish failed', delayMs));
        this.metrics.retry('outbox_publisher', 'infrastructure');
        this.logger.error('outbox_publish_failed', { eventId: message.id, aggregateId: message.aggregateId, correlationId: typeof message.payload.correlationId === 'string' ? message.payload.correlationId : undefined, attempt: message.attempts, component: 'outbox_publisher', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' });
      } finally {
        clearInterval(renewalInterval);
      }
    }
    if (claimed.length > 0 && published === claimed.length) this.metrics.outboxLag(0);
    return published;
  }

  private shouldCrashAfterSend(): boolean {
    if (process.env.NODE_ENV !== 'test' || process.env.OUTBOX_FAULT_INJECTION !== 'crash-after-send-before-mark-published' || this.crashFaultInjected) return false;
    this.crashFaultInjected = true;
    return true;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        await this.publishBatch();
      } catch (error: unknown) {
        this.metrics.retry('outbox_publisher', 'infrastructure');
        this.logger.error('outbox_publisher_failed', { component: 'outbox_publisher', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
