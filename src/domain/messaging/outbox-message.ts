import type { IntegrationEvent } from '../integration-events/integration-events';

export enum OutboxMessageStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  version: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  claimedAt?: Date;
  claimToken?: string;
  publishedAt?: Date;
  lastError?: string;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly version: number,
    public readonly payload: Record<string, unknown>,
    public readonly occurredAt: Date,
    public readonly createdAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _claimedAt?: Date,
    private _claimToken?: string,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  public static enqueue(event: IntegrationEvent<unknown>, createdAt = new Date()): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, event.version, event.toJSON(), event.occurredAt, createdAt, 0, new Date(0));
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, state.version, state.payload, new Date(state.occurredAt), new Date(state.createdAt), state.attempts, new Date(state.nextAttemptAt), state.claimedAt ? new Date(state.claimedAt) : undefined, state.claimToken, state.publishedAt ? new Date(state.publishedAt) : undefined, state.lastError);
  }

  public get attempts(): number { return this._attempts; }
  public get nextAttemptAt(): Date { return new Date(this._nextAttemptAt); }
  public get claimedAt(): Date | undefined { return this._claimedAt ? new Date(this._claimedAt) : undefined; }
  public get claimToken(): string | undefined { return this._claimToken; }
  public get publishedAt(): Date | undefined { return this._publishedAt ? new Date(this._publishedAt) : undefined; }
  public get lastError(): string | undefined { return this._lastError; }
  public isPending(): boolean { return !this._publishedAt; }
  public isDue(now: Date): boolean { return this.isPending() && this._nextAttemptAt <= now; }
}
