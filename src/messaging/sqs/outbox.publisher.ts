import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TypeOrmOutboxRepository } from '../../persistence/repositories/messaging-repositories';
import { SqsClientService } from './sqs-client';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private polling?: Promise<void>;

  public constructor(private readonly dataSource: DataSource, private readonly sqs: SqsClientService) {}

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
    let published = 0;
    for (const message of claimed) {
      const token = message.claimToken;
      if (!token) continue;
      let leaseLost = false;
      const renewalInterval = setInterval(() => {
        void this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).renewClaim(message.id, token, new Date())).then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            console.error(JSON.stringify({ event: 'outbox_lease_lost', eventId: message.id, aggregateId: message.aggregateId }));
          }
        }).catch((error: unknown) => {
          console.error(JSON.stringify({ event: 'outbox_lease_renewal_failed', eventId: message.id, aggregateId: message.aggregateId, error: error instanceof Error ? error.message : 'unknown' }));
        });
      }, Math.max(250, Math.floor(leaseMs / 3)));
      try {
        await this.sqs.send(JSON.stringify(message.payload), message.aggregateId, message.id);
        const acknowledged = !leaseLost && await this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).markPublished(message.id, token, new Date()));
        if (acknowledged) published += 1;
      } catch (error: unknown) {
        const delayMs = Math.min(60000, 1000 * (2 ** Math.min(message.attempts - 1, 6)));
        await this.dataSource.transaction(async (manager) => new TypeOrmOutboxRepository(manager).scheduleRetry(message.id, token, new Date(), error instanceof Error ? error.message : 'SQS publish failed', delayMs));
        console.error(JSON.stringify({ event: 'outbox_publish_failed', eventId: message.id, aggregateId: message.aggregateId, attempt: message.attempts, error: error instanceof Error ? error.message : 'unknown' }));
      } finally {
        clearInterval(renewalInterval);
      }
    }
    return published;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        await this.publishBatch();
      } catch (error: unknown) {
        console.error(JSON.stringify({ event: 'outbox_publisher_failed', error: error instanceof Error ? error.message : 'unknown' }));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
