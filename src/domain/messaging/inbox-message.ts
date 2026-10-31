export enum InboxMessageStatus {
  Received = 'RECEIVED',
  Processed = 'PROCESSED',
  Failed = 'FAILED',
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  attempts: number;
  status: InboxMessageStatus;
  processedAt?: Date;
  lastError?: string;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _attempts: number,
    private _status: InboxMessageStatus,
    private _processedAt?: Date,
    private _lastError?: string,
  ) {}

  public static receive(props: Omit<InboxMessageState, 'status' | 'attempts'> & { receivedAt?: Date }): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.receivedAt ?? new Date()), 1, InboxMessageStatus.Received);
  }

  public static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, new Date(state.receivedAt), state.attempts, state.status, state.processedAt ? new Date(state.processedAt) : undefined, state.lastError);
  }

  public get attempts(): number { return this._attempts; }
  public get status(): InboxMessageStatus { return this._status; }
  public get processedAt(): Date | undefined { return this._processedAt ? new Date(this._processedAt) : undefined; }
  public get lastError(): string | undefined { return this._lastError; }
  public isProcessed(): boolean { return this._status === InboxMessageStatus.Processed; }
  public markProcessed(at: Date): void { this._status = InboxMessageStatus.Processed; this._processedAt = new Date(at); this._lastError = undefined; }
  public markFailed(error: string): void { this._status = InboxMessageStatus.Failed; this._lastError = error.slice(0, 2000); }
}
