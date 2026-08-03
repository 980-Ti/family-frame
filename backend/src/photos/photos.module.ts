import { Module } from "@nestjs/common";
import { AlbumsModule } from "../albums/albums.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { PhotosController } from "./photos.controller.js";
import { PhotosService } from "./photos.service.js";
import { StorageService } from "./storage.service.js";

@Module({
  imports: [AuthModule, AlbumsModule],
  controllers: [PhotosController],
  providers: [PhotosService, StorageService],
  exports: [StorageService]
})
export class PhotosModule {}
