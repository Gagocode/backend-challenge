import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from '../src/domain/money/money';

describe('Money', () => {
  test('normalizes valid decimal strings to two fractional digits', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.50',
      currency: 'BRL',
    });
    expect(Money.from({ amount: '00025.50', currency: 'BRL' }).toString()).toBe('25.50');
  });

  test('supports exact addition without floating-point loss', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(result.toString()).toBe('0.30');
  });

  test('supports subtraction and negative results exactly', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).subtract(
      Money.from({ amount: '0.30', currency: 'BRL' }),
    );

    expect(result.toString()).toBe('-0.20');
    expect(result.isNegative()).toBe(true);
    expect(result.negate().toString()).toBe('0.20');
  });

  test('supports zero, positive, negative, comparison and equality checks', () => {
    const zero = Money.zero('BRL');
    const positive = Money.from({ amount: '1.00', currency: 'BRL' });
    const smaller = Money.from({ amount: '0.99', currency: 'BRL' });

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(smaller.isLessThan(positive)).toBe(true);
    expect(positive.equals(Money.from({ amount: '1.00', currency: 'BRL' }))).toBe(true);
  });

  test('supports arbitrarily large integer amounts without precision loss', () => {
    const amount = '999999999999999999999999999999999999.99';
    const money = Money.from({ amount, currency: 'BRL' });

    expect(money.toString()).toBe(amount);
    expect(money.add(Money.zero('BRL')).toString()).toBe(amount);
  });

  test('rejects malformed, negative and over-precise amounts', () => {
    const invalidAmounts = [
      '',
      ' ',
      '-1.00',
      '+1.00',
      '1.001',
      '1.0000',
      '1e2',
      'NaN',
      'Infinity',
      '.50',
      '1.',
    ];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  test('rejects invalid currencies', () => {
    for (const currency of ['', 'brl', 'BR', 'BRLL', '123']) {
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
  });

  test('rejects operations and comparisons across currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });

  test('does not mutate operands when performing operations', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });
    const result = original.add(Money.from({ amount: '5.00', currency: 'BRL' }));

    expect(original.toString()).toBe('10.00');
    expect(result.toString()).toBe('15.00');
  });
});
