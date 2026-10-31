import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { InvalidMoneyError, Money } from '../../domain/money/money';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction';
import { FinancialConflictError, InvalidFinancialOperationError, WalletNotFoundError } from '../../application/financial-errors';
import { InvalidWagerTransactionError } from '../../domain/wager-transaction/wager-transaction';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import type { ProcessWagerTransactionResult } from '../../application/use-cases/process-wager-transaction.use-case';
import { hashPayload, hashWagerTransactionPayload } from '../../application/messaging/payload-hash';
import type { FinancialUnitOfWork } from '../../application/ports/financial-repositories';
import { SqsClientService } from './sqs-client';
import { MetricsService } from '../../observability/metrics.service';
import { StructuredLogger, safeCorrelationId } from '../../observability/structured-logger';

interface WagerTransactionMessage {
  messageId: string;
  correlationId?: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

export class InvalidSqsMessageError extends Error {
  public constructor(message: string) { super(message); this.name = 'InvalidSqsMessageError'; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value: unknown, maxLength = 255): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const exactProperties = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new InvalidSqsMessageError(`${label} contains unexpected properties`);
};

export const parseWagerTransactionMessage = (body: string): WagerTransactionMessage => {
  let candidate: unknown;
  try { candidate = JSON.parse(body) as unknown; } catch { throw new InvalidSqsMessageError('Message body is not valid JSON'); }
  if (!isRecord(candidate)) throw new InvalidSqsMessageError('Message envelope is invalid');
  exactProperties(candidate, ['messageId', 'type', 'occurredAt', 'correlationId', 'data'], 'Message envelope');
  if (!isNonEmptyString(candidate.messageId) || candidate.type !== 'WagerTransactionRequested' || !isNonEmptyString(candidate.occurredAt) || Number.isNaN(Date.parse(candidate.occurredAt))) throw new InvalidSqsMessageError('Message envelope is invalid');
  if (candidate.correlationId !== undefined && !isNonEmptyString(candidate.correlationId, 128)) throw new InvalidSqsMessageError('Message correlationId is invalid');
  const data = candidate.data;
  if (!isRecord(data)) throw new InvalidSqsMessageError('Message data is invalid');
  exactProperties(data, ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId'], 'Message data');
  if (!isNonEmptyString(data.providerId, 128) || !isNonEmptyString(data.externalTransactionId) || !isNonEmptyString(data.idempotencyKey) || !isNonEmptyString(data.roundId) || !isNonEmptyString(data.gameId) || !isUuid(data.playerId) || !isUuid(data.walletId)) throw new InvalidSqsMessageError('Message data is invalid');
  if (!isNonEmptyString(data.kind, 16) || !(Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening) as WagerTransactionKind[]).includes(data.kind as WagerTransactionKind)) throw new InvalidSqsMessageError('Message kind is invalid');
  if (data.referenceExternalTransactionId !== undefined && !isNonEmptyString(data.referenceExternalTransactionId)) throw new InvalidSqsMessageError('Message reference is invalid');
  if (!isRecord(data.money)) throw new InvalidSqsMessageError('Message money is invalid');
  exactProperties(data.money, ['amount', 'currency'], 'Message money');
  if (!isNonEmptyString(data.money.amount) || !isNonEmptyString(data.money.currency, 3)) throw new InvalidSqsMessageError('Message money is invalid');
  try { Money.from({ amount: data.money.amount, currency: data.money.currency }); } catch (error: unknown) { throw new InvalidSqsMessageError(error instanceof Error ? error.message : 'Message money is invalid'); }
  return candidate as unknown as WagerTransactionMessage;
};

const isTerminalBusinessError = (error: unknown): boolean => error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError || error instanceof FinancialConflictError || error instanceof InvalidFinancialOperationError || error instanceof WalletNotFoundError;

@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private polling?: Promise<void>;
  private shuttingDown = false;
  private crashFaultInjected = false;
  private readonly abortController = new AbortController();

  public constructor(
    private readonly sqs: SqsClientService,
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly process: ProcessWagerTransactionUseCase,
    private readonly logger = new StructuredLogger(),
    private readonly metrics = new MetricsService(),
  ) {}

  public onModuleInit(): void {
    if (this.sqs.enabled) {
      this.shuttingDown = false;
      this.running = true;
      this.polling = this.poll();
      this.logger.info('sqs_consumer_started', { consumerName: this.sqs.consumerName, component: 'consumer' });
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.running = false;
    this.abortController.abort();
    if (this.polling) {
      const timeoutMs = Number(process.env.SQS_SHUTDOWN_TIMEOUT_MS ?? Math.max(1000, this.sqs.visibilityTimeoutSeconds * 1000 - 1000));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.polling,
          new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }

  public async processMessage(message: Message): Promise<void> {
    const body = message.Body ?? '';
    const messageId = message.MessageId ?? 'unknown';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    if (receiveCount > 1) this.logger.warn('sqs_message_redelivered', { messageId, consumerName: this.sqs.consumerName, attempt: receiveCount, component: 'consumer' });
    let parsed: WagerTransactionMessage;
    try {
      parsed = parseWagerTransactionMessage(body);
    } catch (error: unknown) {
      await this.recordTerminalMessage(messageId, body, error instanceof Error ? error.message : 'Invalid message');
      await this.sqs.sendToDlq(body, messageId);
      this.metrics.dlq('invalid_message');
      this.logger.warn('sqs_message_sent_to_dlq', { messageId, consumerName: this.sqs.consumerName, reason: 'invalid_message', component: 'consumer' });
      if (!this.shuttingDown && message.ReceiptHandle) await this.sqs.delete(message.ReceiptHandle);
      return;
    }

    const payloadHash = hashWagerTransactionPayload(parsed.data as unknown as Record<string, unknown>);
    let businessTerminal = false;
    let result: ProcessWagerTransactionResult | undefined;
    const startedAt = Date.now();
    const correlationId = safeCorrelationId(parsed.correlationId, safeCorrelationId(parsed.messageId));
    try {
      if (this.shouldInjectTransientFault()) throw new Error('controlled transient consumer fault');
      await this.unitOfWork.execute(async (context) => {
        const receipt = await context.inbox.receive(parsed.messageId, this.sqs.consumerName, payloadHash, new Date(parsed.occurredAt));
        if (receipt.message.isProcessed()) { this.metrics.duplicate('sqs'); this.logger.info('sqs_message_duplicate', { correlationId, messageId: parsed.messageId, consumerName: this.sqs.consumerName, attempt: receiveCount, component: 'consumer' }); return; }
        if (receipt.message.lastError) {
          receipt.message.markFailed(receipt.message.lastError);
          await context.inbox.save(receipt.message);
          businessTerminal = true;
          return;
        }
        try {
          result = await this.process.executeWithinTransaction({ ...parsed.data, kind: parsed.data.kind, money: Money.from(parsed.data.money), payloadHash, correlationId, causationId: parsed.messageId, source: 'sqs' }, context);
          receipt.message.markProcessed(new Date());
          await context.inbox.save(receipt.message);
        } catch (error: unknown) {
          if (!isTerminalBusinessError(error)) throw error;
          receipt.message.markFailed(error instanceof Error ? error.message : 'Terminal business error');
          await context.inbox.save(receipt.message);
          businessTerminal = true;
        }
      });
      if (this.shouldCrashAfterCommitBeforeAck()) process.exit(42);
      if (!this.shuttingDown && message.ReceiptHandle) await this.sqs.delete(message.ReceiptHandle);
      if (result) { this.process.observe(result, { ...parsed.data, kind: parsed.data.kind, money: Money.from(parsed.data.money), payloadHash, correlationId, source: 'sqs', idempotencyKey: parsed.data.idempotencyKey }, 'sqs', startedAt); this.logger.info('sqs_message_processed', { consumerName: this.sqs.consumerName, messageId: parsed.messageId, correlationId, transactionId: result.transaction.id, walletId: result.wallet.id, providerId: result.transaction.providerId, attempt: receiveCount, component: 'consumer' }); }
    } catch (error: unknown) {
      const seconds = Math.min(this.sqs.visibilityTimeoutSeconds, Math.max(1, Math.min(60, 2 ** Math.min(receiveCount, 6))));
      this.metrics.retry('consumer', 'infrastructure');
      this.logger.error('sqs_consumer_retry', { consumerName: this.sqs.consumerName, messageId: parsed.messageId, correlationId, attempt: receiveCount, delayMs: seconds * 1000, component: 'consumer', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' });
      if (message.ReceiptHandle) await this.sqs.retry(message.ReceiptHandle, seconds);
    }
    if (businessTerminal) this.logger.warn('sqs_consumer_terminal', { consumerName: this.sqs.consumerName, messageId: parsed.messageId, correlationId, component: 'consumer', reason: 'business' });
  }

  private shouldInjectTransientFault(): boolean {
    return process.env.NODE_ENV === 'test' && process.env.SQS_FAULT_INJECTION === 'transient-before-processing';
  }

  private shouldCrashAfterCommitBeforeAck(): boolean {
    if (process.env.NODE_ENV !== 'test' || process.env.SQS_FAULT_INJECTION !== 'crash-after-commit-before-ack' || this.crashFaultInjected) return false;
    this.crashFaultInjected = true;
    return true;
  }

  private async recordTerminalMessage(messageId: string, body: string, error: string): Promise<void> {
    const payloadHash = hashPayload({ body });
    await this.unitOfWork.execute(async (context) => {
      const receipt = await context.inbox.receive(messageId, this.sqs.consumerName, payloadHash);
      if (!receipt.message.isProcessed()) {
        receipt.message.markFailed(error);
        await context.inbox.save(receipt.message);
      }
    });
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.sqs.receive(this.abortController.signal);
        for (const message of messages) {
          if (!this.running) break;
          await this.processMessage(message);
        }
      } catch (error: unknown) {
        if (!this.running && this.abortController.signal.aborted) break;
        this.metrics.retry('consumer', 'infrastructure');
        this.logger.error('sqs_consumer_poll_failed', { consumerName: this.sqs.consumerName, component: 'consumer', errorCode: error instanceof Error ? error.constructor.name : 'UnknownError' });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
