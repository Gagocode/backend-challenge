import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

export interface CreateWalletRequest { playerId: string; initialBalance: { amount: string; currency: string } }
export interface SubmitTransactionRequest { providerId: string; externalTransactionId: string; playerId: string; walletId: string; roundId: string; gameId: string; kind: string; money: { amount: string; currency: string }; referenceExternalTransactionId?: string }
export interface WalletResponse { id: string; playerId: string; balance: { amount: string; currency: string }; version: number }
export interface TransactionResponse { transactionId: string; providerId: string; externalTransactionId: string; walletId: string; playerId: string; roundId: string; gameId: string; kind: string; money: { amount: string; currency: string }; status: string; failureCode?: string; referenceTransactionId?: string; idempotentReplay?: boolean; balance?: { amount: string; currency: string } }
export interface LedgerResponse { id: string; walletId: string; transactionId: string; direction: string; money: { amount: string; currency: string }; balanceBefore: { amount: string; currency: string }; balanceAfter: { amount: string; currency: string }; createdAt: string }
export interface ReconciliationResponse { walletId: string; storedBalance: { amount: string; currency: string }; calculatedBalance: { amount: string; currency: string }; difference: { amount: string; currency: string }; consistent: boolean; checkedEntries: number }

export const walletResponse = (wallet: Wallet): WalletResponse => ({ id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version });
export const transactionResponse = (t: WagerTransaction, balance?: Wallet['balance'], replay?: boolean): TransactionResponse => ({ transactionId: t.id, providerId: t.providerId, externalTransactionId: t.externalTransactionId, walletId: t.walletId, playerId: t.playerId, roundId: t.roundId, gameId: t.gameId, kind: t.kind, money: t.money.toJSON(), status: t.status, ...(t.failureCode ? { failureCode: t.failureCode } : {}), ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}), ...(replay !== undefined ? { idempotentReplay: replay } : {}), ...(balance ? { balance: balance.toJSON() } : {}) });
export const ledgerResponse = (e: WalletLedgerEntry): LedgerResponse => ({ id: e.id, walletId: e.walletId, transactionId: e.transactionId, direction: e.direction, money: e.money.toJSON(), balanceBefore: e.balanceBefore.toJSON(), balanceAfter: e.balanceAfter.toJSON(), createdAt: e.createdAt.toISOString() });
export const allowedKinds = Object.values(WagerTransactionKind).filter((kind, index, all) => all.indexOf(kind) === index && kind !== WagerTransactionKind.Opening);
