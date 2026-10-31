import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case';
import { Money } from '../domain/money/money';
import { FinancialQueryService } from './financial-query.service';
import { ledgerResponse, walletResponse } from './contracts';
import type { CreateWalletRequest, LedgerResponse, ReconciliationResponse } from './contracts';
import { HttpValidationPipe } from './validation.pipe';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

@Controller('wallets')
@ApiTags('wallets')
export class WalletsController {
  public constructor(private readonly create: CreateWalletUseCase, private readonly reconcile: ReconcileWalletUseCase, private readonly queries: FinancialQueryService) {}
  @Post()
  @ApiOperation({ summary: 'Create a wallet with its opening balance' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['playerId', 'initialBalance'], properties: { playerId: { type: 'string', format: 'uuid' }, initialBalance: { $ref: '#/components/schemas/Money' } } }, examples: { create: { value: { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', initialBalance: { amount: '1000.00', currency: 'BRL' } } } } })
  @ApiResponse({ status: 201, description: 'Wallet created', schema: { $ref: '#/components/schemas/Wallet' } }) @ApiResponse({ status: 409, description: 'Wallet already exists', schema: { $ref: '#/components/schemas/Error' } }) @ApiResponse({ status: 400, description: 'Invalid request', schema: { $ref: '#/components/schemas/Error' } })
  public async createWallet(@Body(new HttpValidationPipe()) body: CreateWalletRequest) { return walletResponse(await this.create.execute({ id: randomUUID(), playerId: body.playerId, initialBalance: Money.from(body.initialBalance) })); }
  @Get(':walletId')
  @ApiOperation({ summary: 'Get a wallet and current balance' }) @ApiParam({ name: 'walletId', format: 'uuid' }) @ApiResponse({ status: 200, description: 'Wallet found', schema: { $ref: '#/components/schemas/Wallet' } }) @ApiResponse({ status: 404, description: 'Wallet not found', schema: { $ref: '#/components/schemas/Error' } })
  public async getWallet(@Param('walletId') walletId: string) { return walletResponse(await this.queries.wallet(walletId)); }
  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'List wallet ledger entries in ascending (createdAt, id) order' }) @ApiParam({ name: 'walletId', format: 'uuid' }) @ApiQuery({ name: 'cursor', required: false, description: 'Opaque base64url cursor returned as nextCursor; continues strictly after its (createdAt,id) pair' }) @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100, description: 'Page size; defaults to 50' }) @ApiResponse({ status: 200, description: 'Ledger page', schema: { type: 'object', required: ['entries'], properties: { entries: { type: 'array', items: { $ref: '#/components/schemas/LedgerEntry' } }, nextCursor: { type: 'string', description: 'Present only when a subsequent page exists' } } } }) @ApiResponse({ status: 400, description: 'Invalid cursor or limit', schema: { $ref: '#/components/schemas/Error' } }) @ApiResponse({ status: 404, description: 'Wallet not found', schema: { $ref: '#/components/schemas/Error' } })
  public async getLedger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit', new ParseIntPipe({ optional: true })) limit = 50) { if (limit < 1 || limit > 100) throw new Error('INVALID_LIMIT'); const page = await this.queries.ledger(walletId, cursor, limit); return { entries: page.entries.map((entry): LedgerResponse => ledgerResponse(entry)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }; }
  @Post(':walletId/reconciliation')
  @ApiOperation({ summary: 'Compare stored wallet balance with the immutable ledger' }) @ApiParam({ name: 'walletId', format: 'uuid' }) @ApiResponse({ status: 201, description: 'Reconciliation result; divergence is reported, not repaired', schema: { $ref: '#/components/schemas/Reconciliation' } }) @ApiResponse({ status: 404, description: 'Wallet not found', schema: { $ref: '#/components/schemas/Error' } })
  public async reconciliation(@Param('walletId') walletId: string): Promise<ReconciliationResponse> { const result = await this.reconcile.execute(walletId); return { walletId: result.walletId, storedBalance: result.storedBalance.toJSON(), calculatedBalance: result.calculatedBalance.toJSON(), difference: result.difference.toJSON(), consistent: result.consistent, checkedEntries: result.checkedEntries }; }
}
