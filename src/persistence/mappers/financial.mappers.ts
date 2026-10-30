import { Money } from '../../domain/money/money';
import { WagerTransaction, WagerTransactionState } from '../../domain/wager-transaction/wager-transaction';
import { Wallet, WalletState } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry, WalletLedgerEntryState } from '../../domain/wallet/wallet-ledger-entry';
import { WalletEntity } from '../typeorm/entities/wallet.entity';
import { WagerTransactionEntity } from '../typeorm/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../typeorm/entities/wallet-ledger-entry.entity';

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

export const WalletMapper = {
  toEntity(wallet: Wallet): WalletEntity { const e = new WalletEntity(); e.id = wallet.id; e.playerId = wallet.playerId; e.currency = wallet.currency; e.balanceAmount = wallet.balance.toString(); e.version = wallet.version; e.createdAt = wallet.createdAt; e.updatedAt = wallet.updatedAt; return e; },
  toDomain(e: WalletEntity): Wallet { const state: WalletState = { id: e.id, playerId: e.playerId, currency: e.currency, balance: money(e.balanceAmount, e.currency), version: e.version, createdAt: e.createdAt, updatedAt: e.updatedAt }; return Wallet.rehydrate(state); },
};

export const WagerTransactionMapper = {
  toEntity(t: WagerTransaction): WagerTransactionEntity { const e = new WagerTransactionEntity(); e.id = t.id; e.providerId = t.providerId; e.externalTransactionId = t.externalTransactionId; e.idempotencyKey = t.idempotencyKey; e.payloadHash = t.payloadHash; e.walletId = t.walletId; e.playerId = t.playerId; e.roundId = t.roundId; e.gameId = t.gameId; e.kind = t.kind; e.moneyAmount = t.money.toString(); e.currency = t.money.currency; e.referenceExternalTransactionId = t.referenceExternalTransactionId ?? null; e.referenceTransactionId = t.referenceTransactionId ?? null; e.status = t.status; e.failureCode = t.failureCode ?? null; e.createdAt = t.createdAt; e.processedAt = t.processedAt ?? null; return e; },
  toDomain(e: WagerTransactionEntity): WagerTransaction { const state: WagerTransactionState = { id: e.id, providerId: e.providerId, externalTransactionId: e.externalTransactionId, idempotencyKey: e.idempotencyKey, payloadHash: e.payloadHash, walletId: e.walletId, playerId: e.playerId, roundId: e.roundId, gameId: e.gameId, kind: e.kind as WagerTransactionState['kind'], money: money(e.moneyAmount, e.currency), referenceExternalTransactionId: e.referenceExternalTransactionId ?? undefined, createdAt: e.createdAt, status: e.status as WagerTransactionState['status'], referenceTransactionId: e.referenceTransactionId ?? undefined, failureCode: e.failureCode as WagerTransactionState['failureCode'], processedAt: e.processedAt ?? undefined }; return WagerTransaction.rehydrate(state); },
};

export const WalletLedgerEntryMapper = {
  toEntity(t: WalletLedgerEntry): WalletLedgerEntryEntity { const e = new WalletLedgerEntryEntity(); e.id = t.id; e.walletId = t.walletId; e.transactionId = t.transactionId; e.direction = t.direction; e.moneyAmount = t.money.toString(); e.balanceBefore = t.balanceBefore.toString(); e.balanceAfter = t.balanceAfter.toString(); e.currency = t.money.currency; e.createdAt = t.createdAt; return e; },
  toDomain(e: WalletLedgerEntryEntity): WalletLedgerEntry { const state: WalletLedgerEntryState = { id: e.id, walletId: e.walletId, transactionId: e.transactionId, direction: e.direction as LedgerDirection, money: money(e.moneyAmount, e.currency), balanceBefore: money(e.balanceBefore, e.currency), balanceAfter: money(e.balanceAfter, e.currency), createdAt: e.createdAt }; return WalletLedgerEntry.rehydrate(state); },
};
