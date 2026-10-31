import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wallets' })
@Index('uq_wallets_player_currency', ['playerId', 'currency'], { unique: true })
export class WalletEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'player_id', type: 'uuid' }) playerId!: string;
  @Column({ type: 'char', length: 3 }) currency!: string;
  @Column({ name: 'balance_amount', type: 'numeric', precision: 20, scale: 2 }) balanceAmount!: string;
  @Column({ type: 'integer' }) version!: number;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
