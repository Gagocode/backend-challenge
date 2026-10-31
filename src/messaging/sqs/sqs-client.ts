import { Injectable } from '@nestjs/common';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient, type Message, type QueueAttributeName } from '@aws-sdk/client-sqs';
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
    const dlqUrl = await this.queueUrl(this.config.dlq);
    const dlqAttributes = await this.attributes(dlqUrl, ['FifoQueue', 'ContentBasedDeduplication', 'QueueArn', 'RedriveAllowPolicy']);
    this.assertFifo(this.config.dlq, dlqAttributes);
    const dlqArn = dlqAttributes.QueueArn;
    if (!dlqArn) throw new Error(`SQS queue ARN was not returned for ${this.config.dlq}`);

    const mainUrl = await this.queueUrl(this.config.mainQueue);
    const mainAttributes = await this.attributes(mainUrl, ['FifoQueue', 'ContentBasedDeduplication', 'QueueArn', 'RedrivePolicy']);
    this.assertFifo(this.config.mainQueue, mainAttributes);
    if (!mainAttributes.QueueArn) throw new Error(`SQS queue ARN was not returned for ${this.config.mainQueue}`);
    this.assertRedrivePolicy(mainAttributes.RedrivePolicy, dlqArn);
    this.assertRedriveAllowPolicy(dlqAttributes.RedriveAllowPolicy, mainAttributes.QueueArn);

    const outputUrl = await this.queueUrl(this.config.outputQueue);
    const outputAttributes = await this.attributes(outputUrl, ['FifoQueue', 'ContentBasedDeduplication']);
    this.assertFifo(this.config.outputQueue, outputAttributes);
  }

  private async attributes(url: string, names: QueueAttributeName[]): Promise<Record<string, string>> {
    const result = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }));
    return result.Attributes ?? {};
  }

  private assertFifo(queueName: string, attributes: Record<string, string>): void {
    if (attributes.FifoQueue !== 'true' || attributes.ContentBasedDeduplication !== 'false') {
      throw new Error(`SQS queue ${queueName} is not configured as the expected FIFO queue`);
    }
  }

  private assertRedrivePolicy(policy: string | undefined, dlqArn: string): void {
    if (!policy) throw new Error(`SQS queue ${this.config.mainQueue} has no redrive policy`);
    let parsed: { deadLetterTargetArn?: string; maxReceiveCount?: string };
    try {
      parsed = JSON.parse(policy) as { deadLetterTargetArn?: string; maxReceiveCount?: string };
    } catch {
      throw new Error(`SQS queue ${this.config.mainQueue} has an invalid redrive policy`);
    }
    if (parsed.deadLetterTargetArn !== dlqArn || parsed.maxReceiveCount !== '5') {
      throw new Error(`SQS queue ${this.config.mainQueue} has an unexpected redrive policy`);
    }
  }

  private assertRedriveAllowPolicy(policy: string | undefined, mainArn: string): void {
    if (!policy) throw new Error(`SQS queue ${this.config.dlq} has no redrive allow policy`);
    let parsed: { redrivePermission?: string; sourceQueueArns?: string[] };
    try {
      parsed = JSON.parse(policy) as { redrivePermission?: string; sourceQueueArns?: string[] };
    } catch {
      throw new Error(`SQS queue ${this.config.dlq} has an invalid redrive allow policy`);
    }
    if (parsed.redrivePermission !== 'byQueue' || !parsed.sourceQueueArns?.includes(mainArn)) {
      throw new Error(`SQS queue ${this.config.dlq} has an unexpected redrive allow policy`);
    }
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
