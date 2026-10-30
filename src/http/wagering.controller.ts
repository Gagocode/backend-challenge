import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../domain/wager-transaction/wager-transaction';
import { Money } from '../domain/money/money';
import { FinancialQueryService } from './financial-query.service';
import { transactionResponse } from './contracts';
import type { SubmitTransactionRequest } from './contracts';
import { HttpValidationPipe } from './validation.pipe';

const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue) : value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((out, key) => { out[key] = canonicalValue((value as Record<string, unknown>)[key]); return out; }, {}) : value;
const canonical = (value: Record<string, unknown>): string => JSON.stringify(canonicalValue(value));
const hashPayload = (body: SubmitTransactionRequest): string => createHash('sha256').update(canonical(body as unknown as Record<string, unknown>)).digest('hex');

@Controller()
export class WageringController {
  public constructor(private readonly process: ProcessWagerTransactionUseCase, private readonly queries: FinancialQueryService) {}
  @Get('wagering/transactions/:transactionId')
  public async getTransaction(@Param('transactionId') id: string) { const transaction = await this.queries.transaction(id); if (!transaction) throw new Error('NOT_FOUND'); return transactionResponse(transaction); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public async getExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) { const transaction = await this.queries.externalTransaction(providerId, externalId); if (!transaction) throw new Error('NOT_FOUND'); return transactionResponse(transaction); }
  @Post('wagering/transactions')
  public async submit(@Headers('idempotency-key') key: string | undefined, @Body(new HttpValidationPipe()) body: SubmitTransactionRequest, @Res({ passthrough: true }) response: { status: (code: number) => void }) { if (!key || key.trim() === '') throw new Error('MISSING_IDEMPOTENCY_KEY'); const result = await this.process.execute({ ...body, idempotencyKey: key, payloadHash: hashPayload(body), kind: body.kind as unknown as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>, money: Money.from(body.money) }); if (result.transaction.status === 'REJECTED') response.status(HttpStatus.UNPROCESSABLE_ENTITY); else if (result.transaction.status === 'PENDING_REFERENCE') response.status(HttpStatus.ACCEPTED); else response.status(result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED); return transactionResponse(result.transaction, result.balanceAtProcessing ?? result.wallet.balance, result.idempotentReplay); }
}
