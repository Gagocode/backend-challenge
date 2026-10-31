import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { InvalidMoneyError } from '../domain/money/money';
import { InvalidWagerTransactionError } from '../domain/wager-transaction/wager-transaction';
import { FinancialConflictError, InvalidFinancialOperationError, WalletNotFoundError } from '../application/financial-errors';
import { StructuredLogger, safeCorrelationId } from '../observability/structured-logger';

const transientPostgresCodes = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '40001', '40P01', '53300', '55P03', '57P01', '57P02', '57P03',
]);

const databaseCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  if (typeof candidate.code === 'string') return candidate.code;
  return typeof candidate.driverError?.code === 'string' ? candidate.driverError.code : undefined;
};

export const isTransientInfrastructureError = (error: unknown): boolean => {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; errno?: unknown; driverError?: { code?: unknown; errno?: unknown } };
    const transportCodes = [candidate.code, candidate.errno, candidate.driverError?.code, candidate.driverError?.errno];
    if (transportCodes.some((code) => code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT')) return true;
  }
  const code = databaseCode(error);
  return code !== undefined && transientPostgresCodes.has(code);
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  public constructor(private readonly logger = new StructuredLogger()) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    const request = context.getRequest<{ headers?: Record<string, unknown> }>();
    const correlationId = safeCorrelationId(request.headers?.['x-correlation-id']);
    let status = HttpStatus.INTERNAL_SERVER_ERROR; let code = 'INTERNAL_ERROR'; let message = 'Internal server error';
    if (error instanceof HttpException) { status = error.getStatus(); const payload = error.getResponse(); response.status(status).json(typeof payload === 'string' ? { code: 'HTTP_ERROR', message: payload } : payload); return; }
    if (error instanceof Error && error.message === 'NOT_FOUND') { status = 404; code = 'NOT_FOUND'; message = 'Resource was not found'; }
    else if (error instanceof Error && error.message === 'MISSING_IDEMPOTENCY_KEY') { status = 400; code = 'MISSING_IDEMPOTENCY_KEY'; message = 'Idempotency-Key header is required'; }
    else if (error instanceof Error && error.message === 'INVALID_CURSOR') { status = 400; code = 'INVALID_CURSOR'; message = 'cursor is invalid'; }
    else if (error instanceof Error && error.message === 'INVALID_LIMIT') { status = 400; code = 'INVALID_LIMIT'; message = 'limit must be between 1 and 100'; }
    if (error instanceof WalletNotFoundError) { status = 404; code = 'NOT_FOUND'; message = error.message; }
    else if (error instanceof FinancialConflictError) { status = 409; code = 'CONFLICT'; message = error.message; }
    else if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError || error instanceof InvalidFinancialOperationError) { status = 422; code = 'BUSINESS_RULE_REJECTED'; message = error.message; }
    else if (isTransientInfrastructureError(error)) { status = 503; code = 'INFRASTRUCTURE_UNAVAILABLE'; message = 'Required infrastructure is temporarily unavailable'; }
    this.logger.error('http_request_failed', { correlationId, status: String(status), errorCode: code, component: 'http' });
    response.status(status).json({ statusCode: status, code, message, ...(status === 503 ? { retryable: true } : {}) });
  }
}
