import { CurrencyMismatchError, Money } from '../money/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class InvalidWalletLedgerEntryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  public static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertCommon(props);
    const createdAt = props.createdAt ?? new Date();
    const expectedBalance =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new InvalidWalletLedgerEntryError(
        'Ledger entry balance does not match its direction and movement',
      );
    }

    if (props.balanceAfter.isNegative()) {
      throw new InvalidWalletLedgerEntryError('Ledger entry cannot produce a negative balance');
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(createdAt),
    );
  }

  /** Rebuilds persisted state without revalidating the transition arithmetic. */
  public static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  public get createdAt(): Date {
    return new Date(this._createdAt);
  }

  public isBalanced(): boolean {
    try {
      const expectedBalance =
        this.direction === LedgerDirection.Debit
          ? this.balanceBefore.subtract(this.money)
          : this.balanceBefore.add(this.money);
      return expectedBalance.equals(this.balanceAfter);
    } catch (error) {
      if (error instanceof CurrencyMismatchError) {
        return false;
      }
      throw error;
    }
  }

  private static assertCommon(props: CreateWalletLedgerEntryProps): void {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvalidWalletLedgerEntryError('Ledger identifiers are required');
    }
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new InvalidWalletLedgerEntryError('Ledger direction is invalid');
    }
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new CurrencyMismatchError(props.balanceBefore.currency, props.money.currency);
    }
    if (props.money.isNegative() || props.balanceBefore.isNegative()) {
      throw new InvalidWalletLedgerEntryError('Ledger amounts cannot be negative');
    }
  }
}
