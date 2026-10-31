import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

export interface LivenessResponse {
  status: 'ok';
}

@Controller('health')
@ApiTags('health')
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: 'Check process liveness' }) @ApiResponse({ status: 200, description: 'Process is alive', schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ok'] } } } })
  live(): LivenessResponse {
    return { status: 'ok' };
  }
}
