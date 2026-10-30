import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository { save(wallet: Wallet): Promise<Wallet>; findById(id: string, forUpdate?: boolean): Promise<Wallet | undefined>; findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>; }
export interface WagerTransactionRepository { save(transaction: WagerTransaction): Promise<WagerTransaction>; findById(id: string): Promise<WagerTransaction | undefined>; findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>; findByProviderAndIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>; findByStatus(status: string): Promise<WagerTransaction[]>; }
export interface WalletLedgerEntryRepository { save(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>; findById(id: string): Promise<WalletLedgerEntry | undefined>; findByWalletId(walletId: string): Promise<WalletLedgerEntry[]>; findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>; }
