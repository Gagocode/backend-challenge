import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Optional } from '@nestjs/common';
import { SqsClientService } from './messaging/sqs/sqs-client';
import { StructuredLogger } from './observability/structured-logger';

interface ReadinessResponse {
  status: 'ok';
  dependencies: {
    postgres: 'up';
    sqs?: 'up';
  };
}

@Controller('health')
export class ReadinessController {
  public constructor(private readonly dataSource: DataSource, @Optional() private readonly sqs?: SqsClientService, @Optional() private readonly logger = new StructuredLogger()) {}

  @Get('ready')
  public async ready(): Promise<ReadinessResponse> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      this.logger.error('readiness_dependency_failed', { dependency: 'postgres', component: 'health' });
      throw new ServiceUnavailableException({
        status: 'not_ready',
        dependencies: { postgres: 'down' },
      });
    }
    if (this.sqs) {
      try {
        await this.sqs.check();
      } catch {
        this.logger.error('readiness_dependency_failed', { dependency: 'sqs', component: 'health' });
        throw new ServiceUnavailableException({
          status: 'not_ready',
          dependencies: { postgres: 'up', sqs: 'down' },
        });
      }
    }
    return { status: 'ok', dependencies: { postgres: 'up', ...(this.sqs ? { sqs: 'up' } : {}) } };
  }
}
