import { Money } from '../money/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  ReversalInsufficientBalance = 'REVERSAL_INSUFFICIENT_BALANCE',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_REFERENCE = 'INVALID_REFERENCE',
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  DUPLICATE_REVERSAL = 'DUPLICATE_REVERSAL',
  REVERSAL_INSUFFICIENT_BALANCE = 'REVERSAL_INSUFFICIENT_BALANCE',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidWagerTransactionStateError extends InvalidWagerTransactionError {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionStateError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertCreationProps(props);
    const createdAt = props.createdAt ?? new Date();
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(createdAt),
      WagerTransactionStatus.Pending,
    );
  }

  /** Rebuilds persisted state without replaying or validating a transition. */
  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.assertStateShape(state);
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  public get status(): WagerTransactionStatus {
    return this._status;
  }

  public get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  public get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  public get createdAt(): Date {
    return new Date(this._createdAt);
  }

  public get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  public markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertTransitionAllowed();
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidWagerTransactionError(
        `${this.kind} requires a resolved reference transaction`,
      );
    }
    if (referenceTransactionId !== undefined && !referenceTransactionId) {
      throw new InvalidWagerTransactionError('Reference transaction id cannot be empty');
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
  }

  public markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidWagerTransactionStateError(
        'Only a pending transaction can wait for a reference',
      );
    }
    if (!this.requiresReference()) {
      throw new InvalidWagerTransactionError(`${this.kind} does not require a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  public reject(code: FailureCode): void {
    this.assertTransitionAllowed();
    WagerTransaction.assertFailureCode(code);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  public fail(code: FailureCode): void {
    this.assertTransitionAllowed();
    WagerTransaction.assertFailureCode(code);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  public isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  public affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  public requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK requires a reference transaction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not produce a ledger entry');
      default:
        throw new InvalidWagerTransactionError('Transaction kind is invalid');
    }
  }

  /** Validates a loaded reference without resolving or querying persistence. */
  public assertValidReference(reference: WagerTransaction): void {
    if (!this.requiresReference() && this.kind !== WagerTransactionKind.Win) {
      throw new InvalidWagerTransactionError(`${this.kind} cannot reference a transaction`);
    }
    if (
      this.providerId !== reference.providerId ||
      this.playerId !== reference.playerId ||
      this.walletId !== reference.walletId ||
      this.roundId !== reference.roundId
    ) {
      throw new InvalidWagerTransactionError(
        'Reference must belong to the same provider, player, wallet and round',
      );
    }
    if (this.money.currency !== reference.money.currency) {
      throw new InvalidWagerTransactionError('Reference currency does not match transaction');
    }
    if (this.referenceExternalTransactionId !== reference.externalTransactionId) {
      throw new InvalidWagerTransactionError('Reference external transaction id does not match');
    }
    if (this.kind === WagerTransactionKind.Win) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        throw new InvalidWagerTransactionError('WIN can only reference BET');
      }
      return;
    }
    if (!reference.isTerminal() || reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidWagerTransactionError('A reversal must reference a processed transaction');
    }
    if (!this.money.equals(reference.money)) {
      throw new InvalidWagerTransactionError('A reversal must have the same amount as its reference');
    }
    if (this.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      throw new InvalidWagerTransactionError('REFUND can only reference BET');
    }
    if (
      this.kind === WagerTransactionKind.Rollback &&
      reference.kind !== WagerTransactionKind.Bet &&
      reference.kind !== WagerTransactionKind.Win &&
      reference.kind !== WagerTransactionKind.Refund
    ) {
      throw new InvalidWagerTransactionError('ROLLBACK references BET, WIN or REFUND only');
    }
  }

  private assertTransitionAllowed(): void {
    if (this.isTerminal()) {
      throw new InvalidWagerTransactionStateError(
        `Cannot transition terminal transaction ${this.status}`,
      );
    }
  }

  private static assertCreationProps(props: CreateWagerTransactionProps): void {
    WagerTransaction.assertStateShape({
      ...props,
      createdAt: props.createdAt ?? new Date(),
      status: WagerTransactionStatus.Pending,
    });
    if (props.referenceExternalTransactionId === '') {
      throw new InvalidWagerTransactionError('Reference external transaction id cannot be empty');
    }
    if (
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new InvalidWagerTransactionError(`${props.kind} requires an external reference id`);
    }
  }

  private static assertStateShape(state: WagerTransactionState): void {
    const fields = [
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
    ];
    if (fields.some((field) => typeof field !== 'string' || field.length === 0)) {
      throw new InvalidWagerTransactionError('Transaction identifiers and context are required');
    }
    if (!Object.values(WagerTransactionKind).includes(state.kind)) {
      throw new InvalidWagerTransactionError('Transaction kind is invalid');
    }
    if (!Object.values(WagerTransactionStatus).includes(state.status)) {
      throw new InvalidWagerTransactionError('Transaction status is invalid');
    }
    if (state.money.isNegative()) {
      throw new InvalidWagerTransactionError('Transaction money cannot be negative');
    }
  }

  private static assertFailureCode(code: FailureCode): void {
    if (!Object.values(FailureCode).includes(code)) {
      throw new InvalidWagerTransactionError('Failure code is invalid');
    }
  }
}
