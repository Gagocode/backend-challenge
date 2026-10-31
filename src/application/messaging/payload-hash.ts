import { createHash } from 'node:crypto';
import { Money } from '../../domain/money/money';

const canonicalValue = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalValue)
  : value && typeof value === 'object'
    ? Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((out, key) => {
      out[key] = canonicalValue((value as Record<string, unknown>)[key]);
      return out;
    }, {})
    : value;

export const canonicalJson = (value: Record<string, unknown>): string => JSON.stringify(canonicalValue(value));
export const hashPayload = (value: Record<string, unknown>): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

const wagerPayloadFields = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;

/** Hashes only the canonical financial command, never transport metadata. */
export const hashWagerTransactionPayload = (value: Record<string, unknown>): string => {
  const payload = Object.fromEntries(wagerPayloadFields.flatMap((field) => field in value ? [[field, value[field]]] : []));
  const money = payload.money;
  if (money && typeof money === 'object' && !Array.isArray(money)) {
    const candidate = money as Record<string, unknown>;
    if (typeof candidate.amount === 'string' && typeof candidate.currency === 'string') payload.money = Money.from({ amount: candidate.amount, currency: candidate.currency }).toJSON();
  }
  return hashPayload(payload);
};
