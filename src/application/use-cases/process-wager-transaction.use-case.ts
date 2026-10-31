import { randomUUID } from 'node:crypto';
import { CurrencyMismatchError } from '../../domain/money/money';
import { FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction';
import { InsufficientWalletBalanceError } from '../../domain/wallet/wallet';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import type { FinancialTransactionContext, FinancialUnitOfWork } from '../ports/financial-repositories';
import { FinancialConflictError, InvalidFinancialOperationError, WalletNotFoundError } from '../financial-errors';
import { enqueueFinancialEvents } from '../messaging/enqueue-financial-events';
import { MetricsService } from '../../observability/metrics.service';
import { StructuredLogger } from '../../observability/structured-logger';

export interface ProcessWagerTransactionCommand {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: import('../../domain/money/money').Money;
  referenceExternalTransactionId?: string;
  now?: Date;
  correlationId?: string;
  causationId?: string;
  expirePendingReference?: boolean;
  source?: 'http' | 'sqs' | 'pending_reference' | 'system';
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  wallet: import('../../domain/wallet/wallet').Wallet;
  idempotentReplay: boolean;
  balanceAtProcessing?: import('../../domain/money/money').Money;
}

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { driverError?: { code?: string }; code?: string };
  return candidate.driverError?.code === '23505' || candidate.code === '23505';
};

export class ProcessWagerTransactionUseCase {
  public constructor(private readonly unitOfWork: FinancialUnitOfWork, private readonly logger?: StructuredLogger, private readonly metrics?: MetricsService) {}

  public async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const startedAt = Date.now();
    const source = command.source ?? 'system';
    try {
      const result = await this.unitOfWork.execute((context) => this.executeWithinTransaction(command, context));
      return this.observe(result, command, source, startedAt);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        if (this.isLockConflict(error)) this.metrics?.lockConflict('financial_processing');
        this.logger?.error('financial_processing_failed', { correlationId: command.correlationId, providerId: command.providerId, walletId: command.walletId, component: 'financial_processing', errorCode: this.errorCode(error) });
        throw error;
      }
      const replay = await this.unitOfWork.execute(async ({ transactions, wallets }) => {
        const existing = await transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey);
        if (existing) {
          if (!existing.matchesPayload(command.payloadHash)) throw new FinancialConflictError('Idempotency key was used with a different payload');
          const wallet = await wallets.findById(existing.walletId);
          if (!wallet) throw new WalletNotFoundError(existing.walletId);
          return { transaction: existing, wallet, idempotentReplay: true };
        }
        const external = await transactions.findByProviderAndExternalId(command.providerId, command.externalTransactionId);
        if (external) throw new FinancialConflictError('External transaction already exists');
        return undefined;
      });
      if (replay) return this.observe(replay, command, source, startedAt);
      throw error;
    }
  }

  public observe(result: ProcessWagerTransactionResult, command: ProcessWagerTransactionCommand, source = command.source ?? 'system', startedAt = Date.now()): ProcessWagerTransactionResult {
    if (result.idempotentReplay) {
      if (source !== 'pending_reference') this.metrics?.duplicate(source);
      this.logger?.info('financial_transaction_replay', { correlationId: command.correlationId, transactionId: result.transaction.id, walletId: result.wallet.id, providerId: result.transaction.providerId, status: result.transaction.status, source });
    } else {
      this.metrics?.transaction(result.transaction.status, source);
      if (result.transaction.status === WagerTransactionStatus.REJECTED) {
        this.logger?.warn('financial_transaction_rejected', { correlationId: command.correlationId, transactionId: result.transaction.id, walletId: result.wallet.id, providerId: result.transaction.providerId, status: result.transaction.status, errorCode: result.transaction.failureCode, source });
      } else {
        this.logger?.info('financial_transaction_processed', { correlationId: command.correlationId, transactionId: result.transaction.id, walletId: result.wallet.id, providerId: result.transaction.providerId, status: result.transaction.status, source });
      }
    }
    this.metrics?.processingDuration(Date.now() - startedAt, source, result.transaction.status);
    return result;
  }

  private errorCode(error: unknown): string { return error instanceof Error ? error.constructor.name.slice(0, 80) : 'UnknownError'; }
  private isLockConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: string; driverError?: { code?: string } };
    return ['55P03', '40P01', '40001'].includes(candidate.code ?? candidate.driverError?.code ?? '');
  }

  public async executeWithinTransaction(command: ProcessWagerTransactionCommand, context: FinancialTransactionContext): Promise<ProcessWagerTransactionResult> {
    const { wallets, transactions, ledger } = context;
    const existing = await transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey, true);
    if (existing && !existing.matchesPayload(command.payloadHash)) throw new FinancialConflictError('Idempotency key was used with a different payload');
    if (existing && existing.status !== WagerTransactionStatus.PendingReference) return this.replayOrConflict(existing, command.payloadHash, wallets, ledger);

    const wallet = await wallets.findById(command.walletId, true);
    if (!wallet) throw new WalletNotFoundError(command.walletId);
    if (wallet.playerId !== command.playerId) throw new InvalidFinancialOperationError('Transaction player does not match wallet owner');
    if (wallet.currency !== command.money.currency) throw new InvalidFinancialOperationError('Transaction currency does not match wallet');

    const existingAfterLock = await transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey, true);
    if (existingAfterLock && !existingAfterLock.matchesPayload(command.payloadHash)) throw new FinancialConflictError('Idempotency key was used with a different payload');
    if (existingAfterLock && existingAfterLock.status !== WagerTransactionStatus.PendingReference) return this.replayOrConflict(existingAfterLock, command.payloadHash, wallets, ledger);
    const transaction = existingAfterLock ?? WagerTransaction.create({ ...command, id: command.id ?? randomUUID() });
    if (!existingAfterLock) {
      const external = await transactions.findByProviderAndExternalId(command.providerId, command.externalTransactionId, true);
      if (external) throw new FinancialConflictError('External transaction already exists');
    }
    const reference = command.referenceExternalTransactionId
      ? await transactions.findByProviderAndExternalId(command.providerId, command.referenceExternalTransactionId, true)
      : undefined;

    if (transaction.requiresReference() && !reference) {
      if (transaction.status === WagerTransactionStatus.Pending) {
        transaction.markPendingReference();
        const saved = await transactions.save(transaction);
        await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, command.now ?? new Date());
        return { transaction: saved, wallet, idempotentReplay: false };
      }
      if (command.expirePendingReference) {
        transaction.reject(FailureCode.ReferenceNotFound);
        const saved = await transactions.save(transaction);
        await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, command.now ?? new Date());
        return { transaction: saved, wallet, idempotentReplay: false };
      }
      return { transaction, wallet, idempotentReplay: true };
    }
    if (command.referenceExternalTransactionId && !reference) {
      transaction.reject(FailureCode.ReferenceNotFound);
      const saved = await transactions.save(transaction);
      await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, command.now ?? new Date());
      return { transaction: saved, wallet, idempotentReplay: false };
    }
    if (reference) {
      try { transaction.assertValidReference(reference); }
      catch { transaction.reject(FailureCode.InvalidReference); const saved = await transactions.save(transaction); await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, command.now ?? new Date()); return { transaction: saved, wallet, idempotentReplay: false }; }
    }

    const at = command.now ?? new Date();
    if (command.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, at);
      const saved = await transactions.save(transaction);
      await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, at);
      return { transaction: saved, wallet, idempotentReplay: false };
    }

    let entry;
    try {
      const direction = transaction.ledgerDirectionFor(reference);
      entry = direction === LedgerDirection.Debit
        ? wallet.debit({ id: randomUUID(), transactionId: transaction.id, money: command.money, at })
        : wallet.credit({ id: randomUUID(), transactionId: transaction.id, money: command.money, at });
    } catch (error: unknown) {
      if (error instanceof InsufficientWalletBalanceError) {
        transaction.reject(command.kind === WagerTransactionKind.Rollback || command.kind === WagerTransactionKind.Refund ? FailureCode.ReversalInsufficientBalance : FailureCode.InsufficientBalance);
        const saved = await transactions.save(transaction);
        await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, at);
        return { transaction: saved, wallet, idempotentReplay: false };
      }
      if (error instanceof CurrencyMismatchError) {
        transaction.reject(FailureCode.CurrencyMismatch);
        const saved = await transactions.save(transaction);
        await enqueueFinancialEvents(context, saved, wallet, undefined, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, at);
        return { transaction: saved, wallet, idempotentReplay: false };
      }
      throw error;
    }
    transaction.markProcessed(reference?.id, at);
    const saved = await transactions.save(transaction);
    const persistedWallet = await wallets.save(wallet);
    await ledger.save(entry);
    await enqueueFinancialEvents(context, saved, persistedWallet, entry, { correlationId: command.correlationId ?? command.idempotencyKey, ...(command.causationId ? { causationId: command.causationId } : {}) }, at);
    return { transaction: saved, wallet: persistedWallet, idempotentReplay: false, balanceAtProcessing: entry.balanceAfter };
  }

  private async replayOrConflict(transaction: WagerTransaction, payloadHash: string, wallets: FinancialTransactionContext['wallets'], ledger: FinancialTransactionContext['ledger']): Promise<ProcessWagerTransactionResult> {
    if (!transaction.matchesPayload(payloadHash)) throw new FinancialConflictError('Idempotency key was used with a different payload');
    const wallet = await wallets.findById(transaction.walletId);
    if (!wallet) throw new WalletNotFoundError(transaction.walletId);
    const entry = await ledger.findByTransactionId(transaction.id);
    return { transaction, wallet, idempotentReplay: true, ...(entry ? { balanceAtProcessing: entry.balanceAfter } : {}) };
  }
}
