import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface ReadinessResponse {
  status: 'ok';
  dependencies: {
    postgres: 'up';
  };
}

@Controller('health')
export class ReadinessController {
  public constructor(private readonly dataSource: DataSource) {}

  @Get('ready')
  public async ready(): Promise<ReadinessResponse> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', dependencies: { postgres: 'up' } };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        dependencies: { postgres: 'down' },
      });
    }
  }
}
