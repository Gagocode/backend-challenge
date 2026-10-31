import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@Controller()
@ApiTags('observability')
export class MetricsController {
  public constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Export Prometheus metrics' }) @ApiResponse({ status: 200, description: 'Prometheus text exposition format', content: { 'text/plain; version=0.0.4; charset=utf-8': { schema: { type: 'string' } } } })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  public metricsEndpoint(): string { return this.metrics.renderPrometheus(); }
}

