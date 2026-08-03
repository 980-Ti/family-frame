import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module.js";
import { env } from "./common/env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  if (process.env.NODE_ENV === "production") {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }
  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.enableCors({ origin: env.appOrigin, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Family Frame API").setVersion("1.0").build()
  );
  SwaggerModule.setup("api/docs", app, document);

  await app.listen(env.port);
}

void bootstrap();
