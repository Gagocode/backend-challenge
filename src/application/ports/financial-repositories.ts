import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { InboxRepository, OutboxRepository, PendingReferenceClaim } from './messaging-repositories';

export interface WalletRepository { save(wallet: Wallet): Promise<Wallet>; findById(id: string, forUpdate?: boolean): Promise<Wallet | undefined>; findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>; }
export interface WagerTransactionRepository { save(transaction: WagerTransaction): Promise<WagerTransaction>; findById(id: string): Promise<WagerTransaction | undefined>; findByProviderAndExternalId(providerId: string, externalId: string, forUpdate?: boolean): Promise<WagerTransaction | undefined>; findByProviderAndIdempotencyKey(providerId: string, key: string, forUpdate?: boolean): Promise<WagerTransaction | undefined>; findByStatus(status: string): Promise<WagerTransaction[]>; claimPendingReferences(limit: number, now: Date, leaseMs: number): Promise<PendingReferenceClaim[]>; schedulePendingReferenceRetry(id: string, claimToken: string, now: Date, error: string, delayMs: number): Promise<boolean>; }
export interface WalletLedgerEntryRepository { save(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>; findById(id: string): Promise<WalletLedgerEntry | undefined>; findByWalletId(walletId: string): Promise<WalletLedgerEntry[]>; findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>; }

export interface FinancialTransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: WalletLedgerEntryRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface FinancialUnitOfWork {
  execute<T>(work: (context: FinancialTransactionContext) => Promise<T>): Promise<T>;
}
