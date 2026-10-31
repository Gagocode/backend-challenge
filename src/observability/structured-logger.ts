import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  eventId?: string;
  consumerName?: string;
  attempt?: number;
  status?: string;
  reason?: string;
  component?: string;
  errorCode?: string;
  durationMs?: number;
  lagMs?: number;
  delayMs?: number;
  [key: string]: unknown;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  service: string;
  [key: string]: unknown;
}

type Sink = (record: StructuredLogRecord) => void;

const allowedKeys = new Set([
  'correlationId', 'messageId', 'transactionId', 'walletId', 'providerId', 'eventId',
  'consumerName', 'attempt', 'status', 'reason', 'component', 'errorCode', 'aggregateId',
  'durationMs', 'lagMs', 'delayMs', 'source', 'kind', 'queue', 'dependency',
]);

export const safeCorrelationId = (candidate: unknown, fallback: string = randomUUID()): string => {
  if (typeof candidate !== 'string') return fallback;
  const value = candidate.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : fallback;
};

export class StructuredLogger {
  public constructor(private readonly service = 'distributed-wagering-processor', private readonly sink: Sink = (record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }) {}

  public debug(event: string, context: LogContext = {}): void { this.write('debug', event, context); }
  public info(event: string, context: LogContext = {}): void { this.write('info', event, context); }
  public warn(event: string, context: LogContext = {}): void { this.write('warn', event, context); }
  public error(event: string, context: LogContext = {}): void { this.write('error', event, context); }

  private write(level: LogLevel, event: string, context: LogContext): void {
    const safeContext: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (!allowedKeys.has(key) || value === undefined || value === null) continue;
      if (typeof value === 'string' && value.length > 256) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      safeContext[key] = value;
    }
    this.sink({ timestamp: new Date().toISOString(), level, event, service: this.service, ...safeContext });
  }
}

