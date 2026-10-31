import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Optional } from '@nestjs/common';
import { SqsClientService } from './messaging/sqs/sqs-client';
import { StructuredLogger } from './observability/structured-logger';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

interface ReadinessResponse {
  status: 'ok';
  dependencies: {
    postgres: 'up';
    sqs?: 'up';
  };
}

@Controller('health')
@ApiTags('health')
export class ReadinessController {
  public constructor(private readonly dataSource: DataSource, @Optional() private readonly sqs?: SqsClientService, @Optional() private readonly logger = new StructuredLogger()) {}

  @Get('ready')
  @ApiOperation({ summary: 'Check PostgreSQL and SQS readiness' }) @ApiResponse({ status: 200, description: 'Dependencies are available', schema: { type: 'object', required: ['status','dependencies'], properties: { status: { type: 'string', enum: ['ok'] }, dependencies: { type: 'object', properties: { postgres: { type: 'string', enum: ['up'] }, sqs: { type: 'string', enum: ['up'] } } } } } }) @ApiResponse({ status: 503, description: 'A dependency is unavailable', schema: { type: 'object', required: ['status','dependencies'], properties: { status: { type: 'string', enum: ['not_ready'] }, dependencies: { type: 'object', properties: { postgres: { type: 'string', enum: ['up','down'] }, sqs: { type: 'string', enum: ['up','down'] } } } } } })
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
