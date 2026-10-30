import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './http/error.filter';

async function bootstrap(): Promise<void> {
  try {
    const app = await NestFactory.create(AppModule);
    app.useGlobalFilters(new HttpErrorFilter());
    await app.listen(Number(process.env.PORT ?? 3000));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    console.error(JSON.stringify({ event: 'application_startup_failed', message }));
    process.exitCode = 1;
  }
}

void bootstrap();
