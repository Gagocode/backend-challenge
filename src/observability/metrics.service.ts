import { Injectable } from '@nestjs/common';

export const METRIC_NAMES = {
  transactions: 'wager_transactions_total',
  duplicates: 'wager_duplicates_total',
  retries: 'wager_retries_total',
  dlq: 'wager_dlq_messages_total',
  lockConflicts: 'wager_lock_conflicts_total',
  outboxLag: 'wager_outbox_lag_seconds',
  processingDuration: 'wager_processing_duration_seconds',
  reconciliationDivergences: 'wager_reconciliation_divergences_total',
} as const;

type Labels = Record<string, string>;
type Sample = { labels: Labels; value: number };

const keyFor = (labels: Labels): string => Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join(',');
const escapeLabel = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
const formatLabels = (labels: Labels): string => {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}` : '';
};

const statusLabels = new Set(['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']);
const sourceLabels = new Set(['http', 'sqs', 'pending_reference', 'system']);
const retryComponents = new Set(['consumer', 'outbox_publisher', 'pending_reference']);

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Sample>();
  private readonly gauges = new Map<string, Sample>();
  private readonly histograms = new Map<string, { labels: Labels; buckets: number[]; counts: number[]; sum: number; count: number }>();

  public transaction(status: string, source: string): void {
    if (!statusLabels.has(status) || !sourceLabels.has(source)) return;
    this.increment(METRIC_NAMES.transactions, { status });
  }

  public duplicate(source: string): void {
    if (!sourceLabels.has(source)) return;
    this.increment(METRIC_NAMES.duplicates, { source });
  }

  public retry(component: string, reason: string): void {
    if (!retryComponents.has(component)) return;
    this.increment(METRIC_NAMES.retries, { component, reason: reason === 'business' ? 'business' : 'infrastructure' });
  }

  public dlq(reason: string): void { this.increment(METRIC_NAMES.dlq, { reason: reason === 'invalid_message' ? reason : 'max_receive_count' }); }
  public lockConflict(component: string): void { this.increment(METRIC_NAMES.lockConflicts, { component }); }
  public reconciliationDivergence(): void { this.increment(METRIC_NAMES.reconciliationDivergences); }

  public outboxLag(lagMs: number): void {
    if (Number.isFinite(lagMs) && lagMs >= 0) this.setGauge(METRIC_NAMES.outboxLag, lagMs / 1000);
  }

  public processingDuration(durationMs: number, source: string, status: string): void {
    if (!sourceLabels.has(source) || !statusLabels.has(status) || !Number.isFinite(durationMs) || durationMs < 0) return;
    this.observe(METRIC_NAMES.processingDuration, durationMs / 1000, { source, status });
  }

  public increment(name: string, labels: Labels = {}, value = 1): void {
    const key = `${name}|${keyFor(labels)}`;
    const current = this.counters.get(key);
    if (current) current.value += value;
    else this.counters.set(key, { labels: { ...labels }, value });
  }

  public setGauge(name: string, value: number, labels: Labels = {}): void { this.gauges.set(`${name}|${keyFor(labels)}`, { labels: { ...labels }, value }); }

  public observe(name: string, value: number, labels: Labels = {}): void {
    const key = `${name}|${keyFor(labels)}`;
    const histogram = this.histograms.get(key) ?? { labels: { ...labels }, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], counts: Array(11).fill(0) as number[], sum: 0, count: 0 };
    histogram.sum += value;
    histogram.count += 1;
    histogram.buckets.forEach((bucket, index) => { if (value <= bucket) histogram.counts[index] = (histogram.counts[index] ?? 0) + 1; });
    this.histograms.set(key, histogram);
  }

  public snapshot(): { counters: Sample[]; gauges: Sample[]; histograms: Array<{ labels: Labels; buckets: number[]; counts: number[]; sum: number; count: number }> } {
    return { counters: [...this.counters.values()].map((sample) => ({ labels: { ...sample.labels }, value: sample.value })), gauges: [...this.gauges.values()].map((sample) => ({ labels: { ...sample.labels }, value: sample.value })), histograms: [...this.histograms.values()].map((histogram) => ({ ...histogram, labels: { ...histogram.labels }, buckets: [...histogram.buckets], counts: [...histogram.counts] })) };
  }

  public renderPrometheus(): string {
    const lines: string[] = [];
    const definitions: Array<[string, string, string]> = [
      [METRIC_NAMES.transactions, 'Financial transactions by terminal or pending status.', 'counter'],
      [METRIC_NAMES.duplicates, 'Idempotent duplicate deliveries detected.', 'counter'],
      [METRIC_NAMES.retries, 'Operational retries scheduled or requested.', 'counter'],
      [METRIC_NAMES.dlq, 'Messages explicitly sent to the dead letter queue.', 'counter'],
      [METRIC_NAMES.lockConflicts, 'Database lock or serialization conflicts.', 'counter'],
      [METRIC_NAMES.reconciliationDivergences, 'Wallet reconciliation divergences.', 'counter'],
      [METRIC_NAMES.outboxLag, 'Age in seconds of the most recently observed pending outbox event.', 'gauge'],
      [METRIC_NAMES.processingDuration, 'Financial processing duration in seconds.', 'histogram'],
    ];
    for (const [name, help, type] of definitions) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const sample of this.countersFor(name)) lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      for (const sample of this.gaugesFor(name)) lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      for (const histogram of this.histogramsFor(name)) {
        histogram.buckets.forEach((bucket, index) => { lines.push(`${name}_bucket${formatLabels({ ...histogram.labels, le: String(bucket) })} ${histogram.counts[index] ?? 0}`); });
        lines.push(`${name}_bucket${formatLabels({ ...histogram.labels, le: '+Inf' })} ${histogram.count}`, `${name}_sum${formatLabels(histogram.labels)} ${histogram.sum}`, `${name}_count${formatLabels(histogram.labels)} ${histogram.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private countersFor(name: string): Sample[] { return [...this.counters.entries()].filter(([key]) => key.startsWith(`${name}|`)).map(([, sample]) => sample); }
  private gaugesFor(name: string): Sample[] { return [...this.gauges.entries()].filter(([key]) => key.startsWith(`${name}|`)).map(([, sample]) => sample); }
  private histogramsFor(name: string) { return [...this.histograms.entries()].filter(([key]) => key.startsWith(`${name}|`)).map(([, histogram]) => histogram); }
}

