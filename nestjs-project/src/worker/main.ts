import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// Standalone context: no HTTP server. Shutdown hooks let BullMQ workers finish the
// current job and close on SIGTERM (`docker compose stop`) (TD-05).
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'WorkerBootstrap');
}
void bootstrap();
