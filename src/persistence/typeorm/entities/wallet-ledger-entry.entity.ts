import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wallet_ledger_entries' })
@Index('idx_ledger_wallet_created', ['walletId', 'createdAt', 'id'])
@Index('idx_ledger_transaction', ['transactionId'])
export class WalletLedgerEntryEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'transaction_id', type: 'uuid' }) transactionId!: string;
  @Column({ type: 'varchar', length: 6 }) direction!: string;
  @Column({ name: 'money_amount', type: 'numeric', precision: 20, scale: 2 }) moneyAmount!: string;
  @Column({ name: 'balance_before', type: 'numeric', precision: 20, scale: 2 }) balanceBefore!: string;
  @Column({ name: 'balance_after', type: 'numeric', precision: 20, scale: 2 }) balanceAfter!: string;
  @Column({ name: 'currency', type: 'char', length: 3 }) currency!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
