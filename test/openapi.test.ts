import 'reflect-metadata';
import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { isOpenApiEnabled, setupOpenApi } from '../src/http/openapi';
import { HealthController } from '../src/health.controller';
import { ReadinessController } from '../src/readiness.controller';
import { WalletsController } from '../src/http/wallets.controller';
import { WageringController } from '../src/http/wagering.controller';
import { MetricsController } from '../src/observability/metrics.controller';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../src/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../src/application/use-cases/process-wager-transaction.use-case';
import { FinancialQueryService } from '../src/http/financial-query.service';
import { StructuredLogger } from '../src/observability/structured-logger';
import { MetricsService } from '../src/observability/metrics.service';

@Module({
  controllers: [HealthController, ReadinessController, WalletsController, WageringController, MetricsController],
  providers: [
    { provide: DataSource, useValue: {} },
    { provide: CreateWalletUseCase, useValue: {} },
    { provide: ReconcileWalletUseCase, useValue: {} },
    { provide: ProcessWagerTransactionUseCase, useValue: {} },
    { provide: FinancialQueryService, useValue: {} },
    { provide: StructuredLogger, useValue: {} },
    { provide: MetricsService, useValue: {} },
  ],
})
class HttpControllersModule {}

describe('OpenAPI setup', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  test('enables local docs by default and disables production docs unless explicitly enabled', () => {
    expect(isOpenApiEnabled({})).toBe(true);
    expect(isOpenApiEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isOpenApiEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: 'false' })).toBe(false);
    expect(isOpenApiEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' })).toBe(true);
    expect(isOpenApiEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isOpenApiEnabled({ NODE_ENV: 'development', API_DOCS_ENABLED: 'true' })).toBe(true);
    expect(isOpenApiEnabled({ NODE_ENV: 'development', API_DOCS_ENABLED: 'false' })).toBe(false);
    expect(isOpenApiEnabled({ API_DOCS_ENABLED: 'false' })).toBe(false);
  });

  test('serves the Swagger UI and an OpenAPI JSON document at the configured paths', async () => {
    const app = await NestFactory.create(HttpControllersModule, { logger: false });
    close = () => app.close();
    setupOpenApi(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP listener');
    const base = `http://127.0.0.1:${address.port}`;

    const ui = await fetch(`${base}/api/docs`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('swagger-ui');

    const response = await fetch(`${base}/api/docs-json`);
    expect(response.status).toBe(200);
    const document = await response.json() as { openapi: string; paths: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    expect(document.openapi).toStartWith('3.');
    expect(Object.keys(document.paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
      '/metrics',
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      '/wallets',
      '/wallets/{walletId}',
      '/wallets/{walletId}/ledger',
      '/wallets/{walletId}/reconciliation',
      '/wagering/transactions',
      '/wagering/transactions/{transactionId}',
    ].sort());
    expect(document.components?.schemas?.Money).toBeDefined();
    expect(document.components?.schemas?.Transaction).toBeDefined();

    const schemas = document.components?.schemas as Record<string, { properties?: Record<string, { pattern?: string; $ref?: string }> }>;
    const reconciliation = schemas.Reconciliation;
    const differenceRef = reconciliation?.properties?.difference?.$ref;
    expect(differenceRef).toBe('#/components/schemas/MoneyDifference');
    const differenceAmountPattern = schemas.MoneyDifference?.properties?.amount?.pattern;
    expect(differenceAmountPattern).toBe('^-?\\d+\\.\\d{2}$');
    const differenceAmount = new RegExp(differenceAmountPattern!);
    expect(differenceAmount.test('10.00')).toBe(true);
    expect(differenceAmount.test('-10.00')).toBe(true);
    expect(differenceAmount.test('0.00')).toBe(true);

    const nonNegativeAmountPattern = schemas.Money?.properties?.amount?.pattern;
    expect(nonNegativeAmountPattern).toBe('^\\d+(\\.\\d{1,2})?$');
    const nonNegativeAmount = new RegExp(nonNegativeAmountPattern!);
    expect(nonNegativeAmount.test('10.00')).toBe(true);
    expect(nonNegativeAmount.test('0.00')).toBe(true);
    expect(nonNegativeAmount.test('-10.00')).toBe(false);
  });
});
