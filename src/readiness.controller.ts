import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Optional } from '@nestjs/common';
import { SqsClientService } from './messaging/sqs/sqs-client';

interface ReadinessResponse {
  status: 'ok';
  dependencies: {
    postgres: 'up';
    sqs?: 'up';
  };
}

@Controller('health')
export class ReadinessController {
  public constructor(private readonly dataSource: DataSource, @Optional() private readonly sqs?: SqsClientService) {}

  @Get('ready')
  public async ready(): Promise<ReadinessResponse> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        dependencies: { postgres: 'down' },
      });
    }
    if (this.sqs) {
      try {
        await this.sqs.check();
      } catch {
        throw new ServiceUnavailableException({
          status: 'not_ready',
          dependencies: { postgres: 'up', sqs: 'down' },
        });
      }
    }
    return { status: 'ok', dependencies: { postgres: 'up', ...(this.sqs ? { sqs: 'up' } : {}) } };
  }
}
