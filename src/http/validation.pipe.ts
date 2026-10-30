import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { InvalidMoneyError, Money } from '../domain/money/money';
import { allowedKinds } from './contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const text = (value: unknown, name: string, max = 255): string => { if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: `${name} must be a non-empty string` }); return value; };
const object = (value: unknown, name: string): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: `${name} must be an object` }); return value as Record<string, unknown>; };
const exact = (value: Record<string, unknown>, fields: string[], name: string): void => { const unexpected = Object.keys(value).filter((key) => !fields.includes(key)); if (unexpected.length) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: `${name} contains unexpected properties` }); };
const money = (value: unknown, name: string): { amount: string; currency: string } => { const m = object(value, name); exact(m, ['amount', 'currency'], name); if (typeof m.amount !== 'string' || typeof m.currency !== 'string') throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: `${name} amount and currency must be strings` }); try { return Money.from({ amount: m.amount, currency: m.currency }).toJSON(); } catch (error) { throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: error instanceof InvalidMoneyError ? error.message : 'Invalid money' }); } };

@Injectable()
export class HttpValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: { type?: string; metatype?: unknown; data?: string }): unknown {
    if (metadata.type !== 'body') return value;
    const body = object(value, 'body');
    if (metadata.data === 'createWallet' || 'initialBalance' in body) { exact(body, ['playerId', 'initialBalance'], 'body'); const playerId = text(body.playerId, 'playerId'); if (!uuid.test(playerId)) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'playerId must be a UUID' }); return { playerId, initialBalance: money(body.initialBalance, 'initialBalance') }; }
    if (metadata.data === 'submitTransaction' || 'providerId' in body || 'money' in body) { exact(body, ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId'], 'body'); const result = { providerId: text(body.providerId, 'providerId', 128), externalTransactionId: text(body.externalTransactionId, 'externalTransactionId'), playerId: text(body.playerId, 'playerId'), walletId: text(body.walletId, 'walletId'), roundId: text(body.roundId, 'roundId'), gameId: text(body.gameId, 'gameId'), kind: text(body.kind, 'kind'), money: money(body.money, 'money'), ...(body.referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId: text(body.referenceExternalTransactionId, 'referenceExternalTransactionId') } : {}) }; if (!uuid.test(result.playerId) || !uuid.test(result.walletId)) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'playerId and walletId must be UUIDs' }); if (!allowedKinds.includes(result.kind as never)) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'kind is invalid' }); return result; }
    return body;
  }
}
