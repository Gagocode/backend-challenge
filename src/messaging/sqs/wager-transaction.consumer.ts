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

interface WagerTransactionMessage {
  messageId: string;
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
  };
}

export class InvalidSqsMessageError extends Error {
  public constructor(message: string) { super(message); this.name = 'InvalidSqsMessageError'; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const parseMessage = (body: string): WagerTransactionMessage => {
  let candidate: unknown;
  try { candidate = JSON.parse(body) as unknown; } catch { throw new InvalidSqsMessageError('Message body is not valid JSON'); }
  if (!isRecord(candidate) || !isNonEmptyString(candidate.messageId) || candidate.type !== 'WagerTransactionRequested' || !isNonEmptyString(candidate.occurredAt) || Number.isNaN(Date.parse(candidate.occurredAt))) throw new InvalidSqsMessageError('Message envelope is invalid');
  const data = candidate.data;
  if (!isRecord(data) || !['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'].every((key) => isNonEmptyString(data[key])) || !isNonEmptyString(data.kind) || !(Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening) as WagerTransactionKind[]).includes(data.kind as WagerTransactionKind)) throw new InvalidSqsMessageError('Message data is invalid');
  if (!isRecord(data.money) || !isNonEmptyString(data.money.amount) || !isNonEmptyString(data.money.currency)) throw new InvalidSqsMessageError('Message money is invalid');
  try { Money.from({ amount: data.money.amount, currency: data.money.currency }); } catch (error: unknown) { throw new InvalidSqsMessageError(error instanceof Error ? error.message : 'Message money is invalid'); }
  return candidate as unknown as WagerTransactionMessage;
};

const isTerminalBusinessError = (error: unknown): boolean => error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError || error instanceof FinancialConflictError || error instanceof InvalidFinancialOperationError || error instanceof WalletNotFoundError;

@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private polling?: Promise<void>;
  private shuttingDown = false;
  private readonly abortController = new AbortController();

  public constructor(
    private readonly sqs: SqsClientService,
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly process: ProcessWagerTransactionUseCase,
  ) {}

  public onModuleInit(): void {
    if (this.sqs.enabled) {
      this.shuttingDown = false;
      this.running = true;
      this.polling = this.poll();
      console.info(JSON.stringify({ event: 'sqs_consumer_started', consumerName: this.sqs.consumerName }));
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
    let parsed: WagerTransactionMessage;
    try {
      parsed = parseMessage(body);
    } catch (error: unknown) {
      await this.recordTerminalMessage(message.MessageId ?? 'unknown', body, error instanceof Error ? error.message : 'Invalid message');
      await this.sqs.sendToDlq(body, message.MessageId ?? `invalid-${Date.now()}`);
      if (!this.shuttingDown && message.ReceiptHandle) await this.sqs.delete(message.ReceiptHandle);
      return;
    }

    const payloadHash = hashWagerTransactionPayload(parsed.data as unknown as Record<string, unknown>);
    let businessTerminal = false;
    let result: ProcessWagerTransactionResult | undefined;
    try {
      await this.unitOfWork.execute(async (context) => {
        const receipt = await context.inbox.receive(parsed.messageId, this.sqs.consumerName, payloadHash, new Date(parsed.occurredAt));
        if (receipt.message.isProcessed()) return;
        if (receipt.message.lastError) {
          receipt.message.markFailed(receipt.message.lastError);
          await context.inbox.save(receipt.message);
          businessTerminal = true;
          return;
        }
        try {
          result = await this.process.executeWithinTransaction({ ...parsed.data, kind: parsed.data.kind, money: Money.from(parsed.data.money), payloadHash, correlationId: parsed.messageId, causationId: parsed.messageId }, context);
          receipt.message.markProcessed(new Date());
          await context.inbox.save(receipt.message);
        } catch (error: unknown) {
          if (!isTerminalBusinessError(error)) throw error;
          receipt.message.markFailed(error instanceof Error ? error.message : 'Terminal business error');
          await context.inbox.save(receipt.message);
          businessTerminal = true;
        }
      });
      if (!this.shuttingDown && message.ReceiptHandle) await this.sqs.delete(message.ReceiptHandle);
      if (result) console.info(JSON.stringify({ event: 'sqs_message_processed', consumerName: this.sqs.consumerName, messageId: parsed.messageId, correlationId: parsed.messageId, transactionId: result.transaction.id, walletId: result.wallet.id, providerId: result.transaction.providerId, attempt: Number(message.Attributes?.ApproximateReceiveCount ?? 1) }));
    } catch (error: unknown) {
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const seconds = Math.min(this.sqs.visibilityTimeoutSeconds, Math.max(1, Math.min(60, 2 ** Math.min(receiveCount, 6))));
      console.error(JSON.stringify({ event: 'sqs_consumer_retry', consumerName: this.sqs.consumerName, messageId: parsed.messageId, attempt: receiveCount, error: error instanceof Error ? error.message : 'unknown' }));
      if (message.ReceiptHandle) await this.sqs.retry(message.ReceiptHandle, seconds);
    }
    if (businessTerminal) console.info(JSON.stringify({ event: 'sqs_consumer_terminal', consumerName: this.sqs.consumerName, messageId: parsed.messageId }));
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
        console.error(JSON.stringify({ event: 'sqs_consumer_poll_failed', consumerName: this.sqs.consumerName, error: error instanceof Error ? error.message : 'unknown' }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
