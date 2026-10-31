import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../domain/wager-transaction/wager-transaction';
import { Money } from '../domain/money/money';
import { FinancialQueryService } from './financial-query.service';
import { transactionResponse } from './contracts';
import type { SubmitTransactionRequest } from './contracts';
import { HttpValidationPipe } from './validation.pipe';
import { hashWagerTransactionPayload } from '../application/messaging/payload-hash';
import { StructuredLogger, safeCorrelationId } from '../observability/structured-logger';

@Controller()
export class WageringController {
  public constructor(private readonly process: ProcessWagerTransactionUseCase, private readonly queries: FinancialQueryService, private readonly logger: StructuredLogger) {}
  @Get('wagering/transactions/:transactionId')
  public async getTransaction(@Param('transactionId') id: string) { const transaction = await this.queries.transaction(id); if (!transaction) throw new Error('NOT_FOUND'); return transactionResponse(transaction); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public async getExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) { const transaction = await this.queries.externalTransaction(providerId, externalId); if (!transaction) throw new Error('NOT_FOUND'); return transactionResponse(transaction); }
  @Post('wagering/transactions')
  public async submit(@Headers('idempotency-key') key: string | undefined, @Headers('x-correlation-id') correlationId: string | undefined, @Body(new HttpValidationPipe()) body: SubmitTransactionRequest, @Res({ passthrough: true }) response: { status: (code: number) => void }) { if (!key || key.trim() === '') throw new Error('MISSING_IDEMPOTENCY_KEY'); const safeKey = safeCorrelationId(key); const operationCorrelationId = safeCorrelationId(correlationId, safeKey); this.logger.info('http_transaction_received', { correlationId: operationCorrelationId, providerId: body.providerId, walletId: body.walletId, source: 'http' }); const result = await this.process.execute({ ...body, idempotencyKey: key, payloadHash: hashWagerTransactionPayload({ ...body, idempotencyKey: key }), correlationId: operationCorrelationId, source: 'http', kind: body.kind as unknown as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>, money: Money.from(body.money) }); if (result.transaction.status === 'REJECTED') response.status(HttpStatus.UNPROCESSABLE_ENTITY); else if (result.transaction.status === 'PENDING_REFERENCE') response.status(HttpStatus.ACCEPTED); else response.status(result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED); return transactionResponse(result.transaction, result.balanceAtProcessing ?? result.wallet.balance, result.idempotentReplay); }
}
