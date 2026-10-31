import { CurrencyMismatchError, Money } from '../money/money';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  id: string;
  transactionId: string;
  money: Money;
  at?: Date;
}

export class InvalidWalletError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

export class InsufficientWalletBalanceError extends InvalidWalletError {
  public constructor() {
    super('Wallet balance is insufficient for this debit');
    this.name = 'InsufficientWalletBalanceError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  public static open(props: OpenWalletProps): Wallet {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletError('Wallet id and playerId are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Wallet balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(now),
      new Date(now),
    );
  }

  /** Rebuilds persisted state without applying a financial transition. */
  public static rehydrate(state: WalletState): Wallet {
    if (!state.id || !state.playerId || state.version < 1 || !Number.isInteger(state.version)) {
      throw new InvalidWalletError('Persisted wallet state is invalid');
    }
    if (state.balance.currency !== state.currency || state.balance.isNegative()) {
      throw new InvalidWalletError('Persisted wallet balance is invalid');
    }
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get createdAt(): Date {
    return new Date(this._createdAt);
  }

  public get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  public debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(props, LedgerDirection.Debit);
  }

  public credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(props, LedgerDirection.Credit);
  }

  private applyMovement(
    props: WalletMovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (props.money.isNegative()) {
      throw new InvalidWalletError('Wallet movement cannot be negative');
    }

    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this._balance.subtract(props.money)
        : this._balance.add(props.money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientWalletBalanceError();
    }

    const entry = WalletLedgerEntry.create({
      id: props.id,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });

    if (!balanceAfter.equals(this._balance)) {
      this._balance = balanceAfter;
      this._version += 1;
      this._updatedAt = new Date(props.at ?? new Date());
    }
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
