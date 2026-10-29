export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  public constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private static readonly AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/u;
  private static readonly CURRENCY_PATTERN = /^[A-Z]{3}$/u;

  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  public static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a decimal string');
    }

    const currency = Money.validateCurrency(props.currency);
    const match = Money.AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        'Money amount must be a non-negative decimal with at most two fractional digits',
      );
    }

    const integerPartText = match[1];
    if (!integerPartText) {
      throw new InvalidMoneyError('Money amount has no integer part');
    }

    const integerPart = BigInt(integerPartText);
    const fractionalPart = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
    return new Money(integerPart * 100n + fractionalPart, currency);
  }

  public static zero(currency: string): Money {
    return new Money(0n, Money.validateCurrency(currency));
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  public negate(): Money {
    return Money.fromCents(-this.cents, this.currency);
  }

  public isZero(): boolean {
    return this.cents === 0n;
  }

  public isPositive(): boolean {
    return this.cents > 0n;
  }

  public isNegative(): boolean {
    return this.cents < 0n;
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  public equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  public toString(): string {
    const sign = this.cents < 0n ? '-' : '';
    const absoluteCents = this.cents < 0n ? -this.cents : this.cents;
    const integerPart = absoluteCents / 100n;
    const fractionalPart = (absoluteCents % 100n).toString().padStart(2, '0');
    return `${sign}${integerPart.toString()}.${fractionalPart}`;
  }

  private static fromCents(cents: bigint, currency: string): Money {
    return new Money(cents, currency);
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string' || !Money.CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be a three-letter uppercase ISO-4217 code');
    }

    return currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
