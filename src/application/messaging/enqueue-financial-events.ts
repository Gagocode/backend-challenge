import type { FinancialTransactionContext } from '../ports/financial-repositories';
import type { EventContext } from '../../domain/integration-events/integration-events';
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../../domain/integration-events/integration-events';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export async function enqueueFinancialEvents(
  context: FinancialTransactionContext,
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  eventContext: EventContext,
  occurredAt: Date,
): Promise<void> {
  if (transaction.status === 'PENDING_REFERENCE') {
    await context.outbox.enqueue(WagerTransactionPendingReference.from(transaction, eventContext, occurredAt));
    return;
  }
  if (transaction.status === 'REJECTED') {
    await context.outbox.enqueue(WagerTransactionRejected.from(transaction, eventContext, occurredAt));
    return;
  }
  if (transaction.status !== 'PROCESSED') return;
  await context.outbox.enqueue(WagerTransactionProcessed.from(transaction, eventContext, occurredAt));
  if (entry && !entry.balanceBefore.equals(entry.balanceAfter)) {
    await context.outbox.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext, occurredAt));
  }
}
