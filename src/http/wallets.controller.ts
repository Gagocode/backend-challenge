import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case';
import { Money } from '../domain/money/money';
import { FinancialQueryService } from './financial-query.service';
import { ledgerResponse, walletResponse } from './contracts';
import type { CreateWalletRequest, LedgerResponse, ReconciliationResponse } from './contracts';
import { HttpValidationPipe } from './validation.pipe';

@Controller('wallets')
export class WalletsController {
  public constructor(private readonly create: CreateWalletUseCase, private readonly reconcile: ReconcileWalletUseCase, private readonly queries: FinancialQueryService) {}
  @Post()
  public async createWallet(@Body(new HttpValidationPipe()) body: CreateWalletRequest) { return walletResponse(await this.create.execute({ id: randomUUID(), playerId: body.playerId, initialBalance: Money.from(body.initialBalance) })); }
  @Get(':walletId')
  public async getWallet(@Param('walletId') walletId: string) { return walletResponse(await this.queries.wallet(walletId)); }
  @Get(':walletId/ledger')
  public async getLedger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit', new ParseIntPipe({ optional: true })) limit = 50) { if (limit < 1 || limit > 100) throw new Error('INVALID_LIMIT'); const page = await this.queries.ledger(walletId, cursor, limit); return { entries: page.entries.map((entry): LedgerResponse => ledgerResponse(entry)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }; }
  @Post(':walletId/reconciliation')
  public async reconciliation(@Param('walletId') walletId: string): Promise<ReconciliationResponse> { const result = await this.reconcile.execute(walletId); return { walletId: result.walletId, storedBalance: result.storedBalance.toJSON(), calculatedBalance: result.calculatedBalance.toJSON(), difference: result.difference.toJSON(), consistent: result.consistent, checkedEntries: result.checkedEntries }; }
}
