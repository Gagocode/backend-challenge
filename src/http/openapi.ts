import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function isOpenApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.API_DOCS_ENABLED === 'true' || (env.API_DOCS_ENABLED !== 'false' && env.NODE_ENV !== 'production');
}

export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor API')
    .setDescription('HTTP contracts for wallets, wagering transactions, health checks, and metrics. No authentication is configured.')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      Money: { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: { amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', example: '25.00', description: 'Non-negative decimal string; never a floating-point number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' } } },
      MoneyDifference: { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: { amount: { type: 'string', pattern: '^-?\\d+\\.\\d{2}$', example: '-10.00', description: 'Signed decimal string with exactly two fractional digits; never a floating-point number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' } } },
      Wallet: { type: 'object', required: ['id','playerId','balance','version'], properties: { id: { type: 'string', format: 'uuid' }, playerId: { type: 'string', format: 'uuid' }, balance: { $ref: '#/components/schemas/Money' }, version: { type: 'integer', minimum: 0 } } },
      Transaction: { type: 'object', required: ['transactionId','providerId','externalTransactionId','walletId','playerId','roundId','gameId','kind','money','status'], properties: { transactionId: { type: 'string', format: 'uuid' }, providerId: { type: 'string' }, externalTransactionId: { type: 'string' }, walletId: { type: 'string', format: 'uuid' }, playerId: { type: 'string', format: 'uuid' }, roundId: { type: 'string' }, gameId: { type: 'string' }, kind: { type: 'string', enum: ['OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'] }, money: { $ref: '#/components/schemas/Money' }, status: { type: 'string', enum: ['PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'] }, failureCode: { type: 'string', enum: ['INSUFFICIENT_BALANCE','INVALID_REFERENCE','REFERENCE_NOT_FOUND','CURRENCY_MISMATCH','DUPLICATE_REVERSAL','REVERSAL_INSUFFICIENT_BALANCE'] }, referenceTransactionId: { type: 'string', format: 'uuid' }, idempotentReplay: { type: 'boolean' }, balance: { $ref: '#/components/schemas/Money' } } },
      LedgerEntry: { type: 'object', required: ['id','walletId','transactionId','direction','money','balanceBefore','balanceAfter','createdAt'], properties: { id: { type: 'string', format: 'uuid' }, walletId: { type: 'string', format: 'uuid' }, transactionId: { type: 'string', format: 'uuid' }, direction: { type: 'string', enum: ['DEBIT','CREDIT'] }, money: { $ref: '#/components/schemas/Money' }, balanceBefore: { $ref: '#/components/schemas/Money' }, balanceAfter: { $ref: '#/components/schemas/Money' }, createdAt: { type: 'string', format: 'date-time', description: 'UTC timestamp serialized with ISO 8601 Z timezone' } } },
      Reconciliation: { type: 'object', required: ['walletId','storedBalance','calculatedBalance','difference','consistent','checkedEntries'], properties: { walletId: { type: 'string', format: 'uuid' }, storedBalance: { $ref: '#/components/schemas/Money' }, calculatedBalance: { $ref: '#/components/schemas/Money' }, difference: { $ref: '#/components/schemas/MoneyDifference' }, consistent: { type: 'boolean' }, checkedEntries: { type: 'integer', minimum: 0 } } },
      Error: { type: 'object', properties: { statusCode: { type: 'integer' }, code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } } },
    },
  };
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs-json' });
}
