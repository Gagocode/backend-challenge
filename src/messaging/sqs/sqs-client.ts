import { Injectable } from '@nestjs/common';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { createSqsConfig, type SqsConfig } from './sqs.config';

@Injectable()
export class SqsClientService {
  private readonly client: SQSClient;
  private readonly config: SqsConfig;
  private readonly urls = new Map<string, string>();

  public constructor() {
    this.config = createSqsConfig();
    this.client = new SQSClient({ region: this.config.region, endpoint: this.config.endpoint, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  }

  public get enabled(): boolean { return this.config.enabled; }
  public get consumerName(): string { return this.config.consumerName; }
  public get visibilityTimeoutSeconds(): number { return this.config.visibilityTimeoutSeconds; }
  public get outputQueue(): string { return this.config.outputQueue; }

  public async queueUrl(queueName: string): Promise<string> {
    const known = this.urls.get(queueName);
    if (known) return known;
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!result.QueueUrl) throw new Error(`SQS queue URL was not returned for ${queueName}`);
    const resolved = this.config.endpoint ? (() => { const returned = new URL(result.QueueUrl); const configured = new URL(this.config.endpoint); returned.protocol = configured.protocol; returned.host = configured.host; return returned.toString().replace(/\/$/u, ''); })() : result.QueueUrl;
    this.urls.set(queueName, resolved);
    return resolved;
  }

  public async check(): Promise<void> {
    const url = await this.queueUrl(this.config.mainQueue);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['FifoQueue', 'VisibilityTimeout', 'ReceiveMessageWaitTimeSeconds', 'RedrivePolicy'] }));
    const outputUrl = await this.queueUrl(this.config.outputQueue);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: outputUrl, AttributeNames: ['FifoQueue', 'VisibilityTimeout', 'ReceiveMessageWaitTimeSeconds'] }));
    await this.queueUrl(this.config.dlq);
  }

  public async send(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: await this.queueUrl(this.config.outputQueue), MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }));
  }

  public async receive(signal?: AbortSignal): Promise<Message[]> {
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: await this.queueUrl(this.config.mainQueue), MaxNumberOfMessages: this.config.batchSize, WaitTimeSeconds: this.config.receiveWaitSeconds, VisibilityTimeout: this.config.visibilityTimeoutSeconds, MessageSystemAttributeNames: ['ApproximateReceiveCount'], MessageAttributeNames: ['All'] }), signal ? { abortSignal: signal } : undefined);
    return result.Messages ?? [];
  }

  public async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(this.config.mainQueue), ReceiptHandle: receiptHandle }));
  }

  public async retry(receiptHandle: string, visibilityTimeoutSeconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: await this.queueUrl(this.config.mainQueue), ReceiptHandle: receiptHandle, VisibilityTimeout: visibilityTimeoutSeconds }));
  }

  public async sendToDlq(body: string, messageId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: await this.queueUrl(this.config.dlq), MessageBody: body, MessageGroupId: this.config.consumerName, MessageDeduplicationId: messageId }));
  }
}
