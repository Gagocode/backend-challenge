import { describe, expect, test } from 'bun:test';
import { MetricsService, METRIC_NAMES } from '../src/observability/metrics.service';
import { StructuredLogger, safeCorrelationId } from '../src/observability/structured-logger';
import { HealthController } from '../src/health.controller';
import { ReadinessController } from '../src/readiness.controller';

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
    metrics.processingDuration(125, 'http', 'PROCESSED');

    const snapshot = metrics.snapshot();
    const counter = (name: string, labels: Record<string, string>) => snapshot.counters.find((sample) => sample.labels && Object.entries(labels).every(([key, value]) => sample.labels[key] === value) && (name === METRIC_NAMES.transactions ? sample.labels.status === labels.status : true));
    expect(counter(METRIC_NAMES.transactions, { status: 'PROCESSED' })?.value).toBe(1);
    expect(counter(METRIC_NAMES.transactions, { status: 'REJECTED' })?.value).toBe(1);
    expect(snapshot.counters.find((sample) => sample.labels.source === 'sqs' && sample.value === 1)).toBeDefined();
    expect(snapshot.counters.find((sample) => sample.labels.component === 'consumer')?.value).toBe(1);
    expect(snapshot.counters.find((sample) => sample.labels.reason === 'invalid_message')?.value).toBe(1);
    expect(snapshot.counters.find((sample) => sample.labels.component === 'financial_processing')?.value).toBe(1);
    expect(snapshot.gauges.find((sample) => sample.labels && Object.keys(sample.labels).length === 0)?.value).toBe(2.5);
    expect(snapshot.histograms.find((sample) => sample.labels.source === 'http')?.count).toBe(1);
    expect(metrics.renderPrometheus()).toContain('wager_processing_duration_seconds_count');
    expect(metrics.renderPrometheus()).not.toContain('wallet-1');
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

