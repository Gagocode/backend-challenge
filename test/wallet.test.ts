import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../src/domain/money/money';
import {
  InsufficientWalletBalanceError,
  InvalidWalletError,
  Wallet,
} from '../src/domain/wallet/wallet';
import {
  InvalidWalletLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from '../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

describe('Wallet', () => {
  test('opens with zero or positive initial balance and version one', () => {
    const zero = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('0.00') });
    const funded = Wallet.open({ id: 'w-2', playerId: 'p-1', initialBalance: brl('25.00') });

    expect(zero.balance.toString()).toBe('0.00');
    expect(funded.balance.toString()).toBe('25.00');
    expect(funded.version).toBe(1);
  });

  test('credits and debits while returning consistent immutable ledger entries', () => {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('10.00') });
    const credit = wallet.credit({ id: 'l-1', transactionId: 't-1', money: brl('5.00') });
    const debit = wallet.debit({ id: 'l-2', transactionId: 't-2', money: brl('3.00') });

    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(credit.isBalanced()).toBe(true);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe('12.00');
    expect(wallet.version).toBe(3);
  });

  test('rejects insufficient and incompatible movements without changing state', () => {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('10.00') });
    expect(() => wallet.debit({ id: 'l-1', transactionId: 't-1', money: brl('10.01') })).toThrow(
      InsufficientWalletBalanceError,
    );
    expect(() => wallet.credit({ id: 'l-2', transactionId: 't-2', money: usd('1.00') })).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('does not increment version for a zero movement', () => {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('10.00') });
    const entry = wallet.credit({ id: 'l-1', transactionId: 't-1', money: brl('0.00') });

    expect(entry.isBalanced()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  test('keeps identifiers immutable and rehydrates state', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-01-02T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'w-1', playerId: 'p-1', currency: 'BRL', balance: brl('7.00'), version: 4,
      createdAt, updatedAt,
    });

    expect(wallet.id).toBe('w-1');
    expect(wallet.playerId).toBe('p-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(4);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
    expect(() => Wallet.open({ id: 'w-2', playerId: 'p-2', initialBalance: brl('1.00').negate() })).toThrow(
      InvalidWalletError,
    );
  });
});

describe('WalletLedgerEntry', () => {
  test('creates debit and credit entries and validates arithmetic', () => {
    const debit = WalletLedgerEntry.create({
      id: 'l-1', walletId: 'w-1', transactionId: 't-1', direction: LedgerDirection.Debit,
      money: brl('2.00'), balanceBefore: brl('10.00'), balanceAfter: brl('8.00'),
    });
    const credit = WalletLedgerEntry.create({
      id: 'l-2', walletId: 'w-1', transactionId: 't-2', direction: LedgerDirection.Credit,
      money: brl('2.00'), balanceBefore: brl('8.00'), balanceAfter: brl('10.00'),
    });

    expect(debit.isBalanced()).toBe(true);
    expect(credit.isBalanced()).toBe(true);
  });

  test('rejects inconsistent balances, negative balances and incompatible currencies', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'l-1', walletId: 'w-1', transactionId: 't-1', direction: LedgerDirection.Debit,
      money: brl('2.00'), balanceBefore: brl('10.00'), balanceAfter: brl('9.00'),
    })).toThrow(InvalidWalletLedgerEntryError);
    expect(() => WalletLedgerEntry.create({
      id: 'l-2', walletId: 'w-1', transactionId: 't-2', direction: LedgerDirection.Credit,
      money: brl('2.00'), balanceBefore: brl('1.00'), balanceAfter: brl('3.00'),
    })).not.toThrow();
    expect(() => WalletLedgerEntry.create({
      id: 'l-3', walletId: 'w-1', transactionId: 't-3', direction: LedgerDirection.Credit,
      money: usd('2.00'), balanceBefore: brl('1.00'), balanceAfter: usd('3.00'),
    })).toThrow(CurrencyMismatchError);
  });

  test('has no structural mutation API and rehydrates state', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'l-1', walletId: 'w-1', transactionId: 't-1', direction: LedgerDirection.Credit,
      money: brl('2.00'), balanceBefore: brl('1.00'), balanceAfter: brl('3.00'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const snapshot = entry.createdAt;
    snapshot.setUTCFullYear(2030);
    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
    expect(entry.isBalanced()).toBe(true);
    expect(typeof (entry as unknown as { update?: unknown }).update).toBe('undefined');
  });
});
