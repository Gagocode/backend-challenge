import { createHash, randomUUID } from 'node:crypto';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction';
import { Money } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { FinancialUnitOfWork } from '../ports/financial-repositories';
import { FinancialConflictError } from '../financial-errors';
import { enqueueFinancialEvents } from '../messaging/enqueue-financial-events';
import { StructuredLogger } from '../../observability/structured-logger';

export interface CreateWalletCommand { id: string; playerId: string; initialBalance: Money; now?: Date; }

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { driverError?: { code?: string }; code?: string };
  return candidate.driverError?.code === '23505' || candidate.code === '23505';
};

export class CreateWalletUseCase {
  public constructor(private readonly unitOfWork: FinancialUnitOfWork, private readonly logger?: StructuredLogger) {}

  public async execute(command: CreateWalletCommand): Promise<Wallet> {
    try {
      return await this.unitOfWork.execute(async ({ wallets, transactions, ledger, inbox, outbox }) => {
        const existing = await wallets.findByPlayerAndCurrency(command.playerId, command.initialBalance.currency);
        if (existing) throw new FinancialConflictError('A wallet already exists for this player and currency');

        const wallet = Wallet.open({ id: command.id, playerId: command.playerId, initialBalance: command.initialBalance, now: command.now });
        const persistedWallet = await wallets.save(wallet);
        if (!command.initialBalance.isPositive()) return persistedWallet;

        const at = command.now ?? new Date();
        const opening = WagerTransaction.create({
          id: randomUUID(), providerId: 'internal', externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `opening:${wallet.id}`, payloadHash: createHash('sha256').update(`opening:${wallet.id}:${wallet.balance.toString()}`).digest('hex'),
          walletId: wallet.id, playerId: wallet.playerId, roundId: `opening:${wallet.id}`, gameId: 'wallet',
          kind: WagerTransactionKind.Opening, money: command.initialBalance, createdAt: at,
        });
        opening.markProcessed(undefined, at);
        const openingEntry = WalletLedgerEntry.create({
          id: randomUUID(), walletId: wallet.id, transactionId: opening.id, direction: opening.ledgerDirectionFor(),
          money: command.initialBalance, balanceBefore: Money.zero(wallet.currency), balanceAfter: command.initialBalance, createdAt: at,
        });
        await transactions.save(opening);
        await ledger.save(openingEntry);
        await enqueueFinancialEvents({ wallets, transactions, ledger, inbox, outbox }, opening, persistedWallet, openingEntry, { correlationId: `opening:${wallet.id}` }, at);
        return persistedWallet;
      });
    } catch (error: unknown) {
      if (error instanceof FinancialConflictError) { this.logger?.warn('wallet_creation_rejected', { errorCode: 'WALLET_CONFLICT', component: 'financial_processing' }); throw error; }
      if (isUniqueViolation(error)) throw new FinancialConflictError('A wallet already exists for this player and currency');
      throw error;
    }
  }
}
