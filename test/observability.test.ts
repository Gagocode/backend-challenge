import { describe, expect, test } from 'bun:test';
import { MetricsService, METRIC_NAMES } from '../src/observability/metrics.service';
import { StructuredLogger, safeCorrelationId } from '../src/observability/structured-logger';
import { HealthController } from '../src/health.controller';
import { ReadinessController } from '../src/readiness.controller';
import { HttpErrorFilter, isTransientInfrastructureError } from '../src/http/error.filter';
import { OutboxPublisher } from '../src/messaging/sqs/outbox.publisher';

describe('structured observability', () => {
  test('emits JSON-safe logs with correlation fields and excludes financial payloads', () => {
    const records: unknown[] = [];
    const logger = new StructuredLogger('test-service', (record) => records.push(record));

    logger.info('financial_transaction_processed', {
      correlationId: 'corr-1', transactionId: 'tx-1', walletId: 'wallet-1', providerId: 'provider-1',
      status: 'PROCESSED', amount: '100.00', currency: 'BRL', payload: { amount: '100.00' }, password: 'secret',
    });

    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).toContain('"correlationId":"corr-1"');
    expect(serialized).toContain('"transactionId":"tx-1"');
    expect(serialized).not.toContain('100.00');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('payload');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  test('does not trust invalid external correlation identifiers', () => {
    expect(safeCorrelationId('bad correlation id', 'generated')).toBe('generated');
    expect(safeCorrelationId('provider-a:operation-1', 'generated')).toBe('provider-a:operation-1');
  });

  test('classifies transient database and transport failures without classifying conflicts', () => {
    expect(isTransientInfrastructureError({ code: '40001' })).toBe(true);
    expect(isTransientInfrastructureError({ driverError: { code: '57P01' } })).toBe(true);
    expect(isTransientInfrastructureError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientInfrastructureError({ code: '23505' })).toBe(false);
    expect(isTransientInfrastructureError(new Error('validation failed'))).toBe(false);
  });

  test('maps transient infrastructure failures to a generic retryable 503', () => {
    let statusCode: number | undefined;
    let body: Record<string, unknown> | undefined;
    const filter = new HttpErrorFilter(new StructuredLogger('test', () => undefined));
    filter.catch({ code: '40001', detail: 'internal database detail' }, {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (status: number) => ({ json: (value: Record<string, unknown>) => { statusCode = status; body = value; } }),
        }),
        getRequest: () => ({ headers: {} }),
      }),
    } as never);

    expect(statusCode).toBe(503);
    expect(body).toMatchObject({ statusCode: 503, code: 'INFRASTRUCTURE_UNAVAILABLE', retryable: true });
    expect(body?.message).toBe('Required infrastructure is temporarily unavailable');
    expect(JSON.stringify(body)).not.toContain('internal database detail');
  });

  test('counts statuses, duplicates, retries, DLQ, locks, lag and processing latency', () => {
    const metrics = new MetricsService();
    metrics.transaction('PROCESSED', 'http');
    metrics.transaction('REJECTED', 'sqs');
    metrics.transaction('NOT_A_STATUS', 'http');
    metrics.duplicate('sqs');
    metrics.retry('consumer', 'infrastructure');
    metrics.dlq('invalid_message');
    metrics.lockConflict('financial_processing');
    metrics.outboxLag(2500);
    metrics.outboxLag(0);
    metrics.processingDuration(125, 'http', 'PROCESSED');

    const snapshot = metrics.snapshot();
    const counter = (name: string, labels: Record<string, string>) => snapshot.counters.find((sample) => sample.labels && Object.entries(labels).every(([key, value]) => sample.labels[key] === value) && (name === METRIC_NAMES.transactions ? sample.labels.status === labels.status : true));
    expect(counter(METRIC_NAMES.transactions, { status: 'PROCESSED' })?.value).toBe(1);
    expect(counter(METRIC_NAMES.transactions, { status: 'REJECTED' })?.value).toBe(1);
    expect(snapshot.counters.find((sample) => sample.labels.source === 'sqs' && sample.value === 1)).toBeDefined();
    expect(snapshot.counters.find((sample) => sample.labels.component === 'consumer')?.value).toBe(1);
    expect(snapshot.counters.find((sample) => sample.labels.reason === 'invalid_message')?.value).toBe(1);
    expect(snapshot.counters.find((sample) => sample.labels.component === 'financial_processing')?.value).toBe(1);
    expect(snapshot.gauges.find((sample) => sample.labels && Object.keys(sample.labels).length === 0)?.value).toBe(0);
    expect(snapshot.histograms.find((sample) => sample.labels.source === 'http')?.count).toBe(1);
    expect(metrics.renderPrometheus()).toContain('wager_processing_duration_seconds_count');
    expect(metrics.renderPrometheus()).not.toContain('wallet-1');
  });

  test('resets outbox lag when a publisher finds no pending rows', async () => {
    const metrics = new MetricsService();
    metrics.outboxLag(5000);
    const dataSource = {
      transaction: async <T>(work: (manager: { query: () => Promise<unknown[]> }) => Promise<T>) => work({ query: async () => [] }),
    };
    await new OutboxPublisher(dataSource as never, { send: async () => undefined } as never, new StructuredLogger('test', () => undefined), metrics).publishBatch();
    expect(metrics.snapshot().gauges.find((sample) => Object.keys(sample.labels).length === 0)?.value).toBe(0);
  });

  test('health liveness is independent of dependencies and readiness checks PostgreSQL and SQS', async () => {
    expect(new HealthController().live()).toEqual({ status: 'ok' });
    const calls: string[] = [];
    const readiness = new ReadinessController({ query: async () => { calls.push('postgres'); return []; } } as never, { check: async () => { calls.push('sqs'); } } as never);
    await expect(readiness.ready()).resolves.toEqual({ status: 'ok', dependencies: { postgres: 'up', sqs: 'up' } });
    expect(calls).toEqual(['postgres', 'sqs']);
  });

  test('readiness reports each unavailable dependency while liveness remains healthy', async () => {
    const postgresDown = new ReadinessController({ query: async () => { throw new Error('down'); } } as never, { check: async () => undefined } as never);
    await expect(postgresDown.ready()).rejects.toMatchObject({ status: 503, response: { dependencies: { postgres: 'down' } } });
    const sqsDown = new ReadinessController({ query: async () => [] } as never, { check: async () => { throw new Error('down'); } } as never);
    await expect(sqsDown.ready()).rejects.toMatchObject({ status: 503, response: { dependencies: { postgres: 'up', sqs: 'down' } } });
    expect(new HealthController().live()).toEqual({ status: 'ok' });
  });
});

