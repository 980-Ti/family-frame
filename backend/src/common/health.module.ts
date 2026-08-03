import { Module } from "@nestjs/common";
import { PhotosModule } from "../photos/photos.module.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [PhotosModule],
  controllers: [HealthController]
})
export class HealthModule {}
