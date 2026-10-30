import { Money } from '../../domain/money/money';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import type { FinancialUnitOfWork } from '../ports/financial-repositories';
import { WalletNotFoundError } from '../financial-errors';

export interface ReconciliationResult { walletId: string; storedBalance: Money; calculatedBalance: Money; difference: Money; consistent: boolean; checkedEntries: number }

export class ReconcileWalletUseCase {
  public constructor(private readonly unitOfWork: FinancialUnitOfWork) {}
  public execute(walletId: string): Promise<ReconciliationResult> {
    return this.unitOfWork.execute(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      let calculated = Money.zero(wallet.currency);
      const entries = await ledger.findByWalletId(walletId);
      for (const entry of entries) calculated = entry.direction === LedgerDirection.Credit ? calculated.add(entry.money) : calculated.subtract(entry.money);
      const difference = calculated.subtract(wallet.balance);
      const result = { walletId, storedBalance: wallet.balance, calculatedBalance: calculated, difference, consistent: difference.isZero(), checkedEntries: entries.length };
      if (!result.consistent) console.error(JSON.stringify({ event: 'wallet_reconciliation_divergence', walletId, checkedEntries: entries.length, storedBalance: wallet.balance.toString(), calculatedBalance: calculated.toString() }));
      return result;
    });
  }
}
