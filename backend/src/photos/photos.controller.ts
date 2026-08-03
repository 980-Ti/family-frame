import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { SessionGuard } from "../auth/session.guard.js";
import type { AuthUser } from "../auth/auth.types.js";
import { parsePhotoFilter } from "../common/photo-filter.js";
import { PhotosService } from "./photos.service.js";
import { RepresentativeDto, StartUploadDto } from "./photos.dto.js";

@Controller()
@UseGuards(SessionGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post("albums/:albumId/uploads")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  start(@CurrentUser() user: AuthUser, @Param("albumId") albumId: string, @Body() dto: StartUploadDto) {
    return this.photos.startUpload(user.id, albumId, dto);
  }

  @Post("photos/:photoId/complete")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  complete(@CurrentUser() user: AuthUser, @Param("photoId") photoId: string) {
    return this.photos.complete(user.id, photoId);
  }

  @Get("albums/:albumId/photos")
  list(
    @CurrentUser() user: AuthUser,
    @Param("albumId") albumId: string,
    @Query("date") date: string,
    @Query("childTagId") childTagId?: string,
    @Query("childTagIds") childTagIds?: string,
    @Query("match") match?: string,
    @Query("untagged") untagged?: string
  ) {
    return this.photos.list(
      user.id,
      albumId,
      date,
      parsePhotoFilter({ childTagId, childTagIds, match, untagged })
    );
  }

  @Get("albums/:albumId/photo-feed")
  feed(
    @CurrentUser() user: AuthUser,
    @Param("albumId") albumId: string,
    @Query("childTagId") childTagId?: string,
    @Query("childTagIds") childTagIds?: string,
    @Query("match") match?: string,
    @Query("untagged") untagged?: string,
    @Query("cursor") cursor?: string,
    @Query("take") take?: string
  ) {
    return this.photos.feed(
      user.id,
      albumId,
      parsePhotoFilter({ childTagId, childTagIds, match, untagged }),
      cursor,
      take ? Number(take) : undefined
    );
  }

  @Get("photos/:photoId/url")
  url(
    @CurrentUser() user: AuthUser,
    @Param("photoId") photoId: string,
    @Query("variant") variant: "thumbnail" | "display" | "original" = "display"
  ) {
    return this.photos.url(user.id, photoId, variant);
  }

  @Put("albums/:albumId/dates/:date/representative")
  representative(
    @CurrentUser() user: AuthUser,
    @Param("albumId") albumId: string,
    @Param("date") date: string,
    @Body() dto: RepresentativeDto
  ) {
    return this.photos.setRepresentative(user.id, albumId, date, dto.photoId);
  }

  @Delete("photos/:photoId")
  remove(@CurrentUser() user: AuthUser, @Param("photoId") photoId: string) {
    return this.photos.remove(user.id, photoId);
  }
}
