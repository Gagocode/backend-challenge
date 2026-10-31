import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './http/error.filter';
import { StructuredLogger } from './observability/structured-logger';

async function bootstrap(): Promise<void> {
  const logger = new StructuredLogger();
  try {
    const app = await NestFactory.create(AppModule, { logger: false });
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    app.useGlobalFilters(new HttpErrorFilter(logger));
    await app.listen(Number(process.env.PORT ?? 3000));
    logger.info('application_started', { component: 'bootstrap' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    new StructuredLogger().error('application_startup_failed', { errorCode: message.slice(0, 100) });
    process.exitCode = 1;
  }
}

void bootstrap();
