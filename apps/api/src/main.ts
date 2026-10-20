import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, swaggerEnabled } from './app.setup';

async function bootstrap() {
  // Body parsers are installed by configureApp (JSON only; uploads use multer).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  configureApp(app);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  new Logger('Bootstrap').log(`API listening on http://${host}:${port}/api/v1${swaggerEnabled() ? ' (docs at /api/docs)' : ''}`);
}
bootstrap();
