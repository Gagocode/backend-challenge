export class FinancialApplicationError extends Error {
  public constructor(message: string) { super(message); this.name = 'FinancialApplicationError'; }
}

export class FinancialConflictError extends FinancialApplicationError {
  public constructor(message: string) { super(message); this.name = 'FinancialConflictError'; }
}

export class WalletNotFoundError extends FinancialApplicationError {
  public constructor(walletId: string) { super(`Wallet ${walletId} was not found`); this.name = 'WalletNotFoundError'; }
}

export class InvalidFinancialOperationError extends FinancialApplicationError {
  public constructor(message: string) { super(message); this.name = 'InvalidFinancialOperationError'; }
}
