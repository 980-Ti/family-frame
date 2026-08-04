import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { PrismaService } from "../common/prisma.service.js";
import { parseAlbumDate } from "../common/album-date.js";
import {
  EMPTY_MEDIA_FILTER,
  mediaFilterWhere,
  type MediaFilter
} from "../common/media-filter.js";
import { AlbumsService } from "../albums/albums.service.js";
import { assertDailyMediaCapacity, canDeleteMedia } from "./policies.js";
import { StorageObjectError, StorageService } from "./storage.service.js";
import type { StartUploadDto } from "./media.dto.js";
import {
  InvalidVideoError,
  processMp4,
  VideoProcessorUnavailableError
} from "./video-processor.js";

const ACTIVE_STATUSES = ["PENDING_UPLOAD", "PROCESSING", "READY"] as const;
const UPLOAD_EXPIRY_MS = 30 * 60 * 1000;
const ASSET_DELETION_EXPIRY_MS = 2 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 25;
const MAX_IMAGE_PIXELS = 60_000_000;
const MAX_CONCURRENT_IMAGE_PROCESSING = 2;
let activeImageProcessing = 0;
const imageProcessingWaiters: Array<() => void> = [];

async function acquireImageProcessingSlot(): Promise<() => void> {
  if (activeImageProcessing >= MAX_CONCURRENT_IMAGE_PROCESSING) {
    await new Promise<void>((resolve) => imageProcessingWaiters.push(resolve));
  } else {
    activeImageProcessing += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = imageProcessingWaiters.shift();
    if (next) next();
    else activeImageProcessing -= 1;
  };
}

@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaService.name);
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly albums: AlbumsService,
    private readonly storage: StorageService
  ) {}

  onModuleInit(): void {
    // ponytail: each API replica runs this idempotent DB-backed sweep; use a dedicated worker only if cleanup volume grows.
    this.cleanupTimer = setInterval(() => void this.cleanupAbandonedMedia(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    void this.cleanupAbandonedMedia();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async cleanupAbandonedMedia(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const uploadCutoff = new Date(Date.now() - UPLOAD_EXPIRY_MS);
      const deletionCutoff = new Date(Date.now() - ASSET_DELETION_EXPIRY_MS);
      const mediaItems = await this.prisma.media.findMany({
        where: {
          OR: [
            {
              status: { in: ["PENDING_UPLOAD", "PROCESSING", "FAILED"] },
              tempObjectKey: { not: null },
              updatedAt: { lt: uploadCutoff }
            },
            { status: "READY", tempObjectKey: { not: null } },
            { status: "DELETED", tempObjectKey: { not: null } },
            { status: "DELETED", mediaAsset: { is: { status: { in: ["READY", "ORPHANED"] } } } },
            {
              status: "DELETED",
              mediaAsset: { is: { status: "DELETING", updatedAt: { lt: deletionCutoff } } }
            }
          ]
        },
        select: {
          id: true,
          status: true,
          tempObjectKey: true,
          mediaAssetId: true,
          failureReason: true,
          updatedAt: true
        },
        orderBy: { updatedAt: "asc" },
        take: CLEANUP_BATCH_SIZE
      });
      for (const media of mediaItems) {
        if (media.status === "READY") {
          try {
            await this.cleanupTempObject(media);
          } catch (error) {
            if (!(error instanceof ServiceUnavailableException)) throw error;
          }
          continue;
        }
        const expiredUpload = media.status !== "DELETED" || media.failureReason === "UPLOAD_EXPIRED";
        if (media.status !== "DELETED") {
          const claimed = await this.prisma.media.updateMany({
            where: { id: media.id, status: media.status, updatedAt: { lt: uploadCutoff } },
            data: { status: "DELETED", failureReason: "UPLOAD_EXPIRED" }
          });
          if (claimed.count === 0) continue;
        }
        let cleanupPending = false;
        try {
          await this.cleanupTempObject(media, expiredUpload ? "UPLOAD_EXPIRED" : null);
        } catch (error) {
          if (!(error instanceof ServiceUnavailableException)) throw error;
          cleanupPending = true;
        }
        try {
          await this.cleanupMediaAsset(media.mediaAssetId);
        } catch (error) {
          if (!(error instanceof ServiceUnavailableException)) throw error;
          cleanupPending = true;
        }
        if (cleanupPending) {
          await this.prisma.media.updateMany({
            where: { id: media.id, status: "DELETED" },
            data: { failureReason: expiredUpload ? "UPLOAD_EXPIRED" : "MEDIA_CLEANUP_PENDING" }
          });
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logger.warn(`보류된 미디어 정리를 완료하지 못했습니다. 다음 주기에 다시 시도합니다: ${cause}`);
    } finally {
      this.cleanupRunning = false;
    }
  }

  async startUpload(userId: string, albumId: string, dto: StartUploadDto) {
    const { album } = await this.albums.requireAlbum(userId, albumId);
    const childTagIds = [...new Set(dto.childTagIds ?? [])];
    const albumDate = parseAlbumDate(dto.date);

    const { media, expiredMedia } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${albumId}:${dto.date}`}))`;
      let existing = await tx.media.findUnique({
        where: { albumId_clientUploadId: { albumId, clientUploadId: dto.clientUploadId } },
        include: { childTags: { include: { childTag: true } } }
      });
      if (existing) {
        const existingTagIds = existing.childTags.map(({ childTag }) => childTag.id).sort();
        const requestedTagIds = [...childTagIds].sort();
        const sameRequest =
          existing.uploadedById === userId &&
          existing.albumDate.getTime() === albumDate.getTime() &&
          existing.originalName === dto.originalName &&
          (existing.capturedAt?.getTime() ?? null) ===
            (dto.capturedAt ? new Date(dto.capturedAt).getTime() : null) &&
          existing.dateSource === (dto.dateSource ?? "USER") &&
          existingTagIds.length === requestedTagIds.length &&
          existingTagIds.every((id, index) => id === requestedTagIds[index]);
        if (!sameRequest) {
          throw new ConflictException({
            code: "UPLOAD_ID_CONFLICT",
            message: "이미 다른 업로드에 사용된 식별자입니다."
          });
        }
        const retryExpiredUpload =
          existing.status === "DELETED" &&
          existing.failureReason === "UPLOAD_EXPIRED" &&
          !existing.tempObjectKey &&
          !existing.mediaAssetId;
        if (existing.status === "FAILED" || retryExpiredUpload) {
          const activeCount = await tx.media.count({
            where: { albumId, albumDate, status: { in: [...ACTIVE_STATUSES] } }
          });
          assertDailyMediaCapacity(activeCount);
        }
        if (retryExpiredUpload) {
          existing = await tx.media.update({
            where: { id: existing.id },
            data: {
              status: "PENDING_UPLOAD",
              tempObjectKey: `temp/${album.familyId}/${randomUUID()}`,
              failureReason: null
            },
            include: { childTags: { include: { childTag: true } } }
          });
        }
        return {
          media: existing,
          expiredMedia: [] as Array<{ id: string; tempObjectKey: string | null }>
        };
      }
      if (childTagIds.length) {
        const validTagCount = await tx.childTag.count({
          where: { albumId, id: { in: childTagIds } }
        });
        if (validTagCount !== childTagIds.length) {
          throw new BadRequestException({
            code: "INVALID_CHILD_TAG",
            message: "이 앨범에 등록된 아이 태그만 선택할 수 있습니다."
          });
        }
      }
      const uploadCutoff = new Date(Date.now() - UPLOAD_EXPIRY_MS);
      const stale = await tx.media.findMany({
        where: {
          albumId,
          albumDate,
          status: { in: ["PENDING_UPLOAD", "PROCESSING"] },
          updatedAt: { lt: uploadCutoff }
        },
        select: { id: true, tempObjectKey: true }
      });
      const expiredMedia: typeof stale = [];
      for (const candidate of stale) {
        const expired = await tx.media.updateMany({
          where: {
            id: candidate.id,
            status: { in: ["PENDING_UPLOAD", "PROCESSING"] },
            updatedAt: { lt: uploadCutoff }
          },
          data: { status: "DELETED", failureReason: "UPLOAD_EXPIRED" }
        });
        if (expired.count) expiredMedia.push(candidate);
      }
      const activeCount = await tx.media.count({
        where: { albumId, albumDate, status: { in: [...ACTIVE_STATUSES] } }
      });
      assertDailyMediaCapacity(activeCount);
      const created = await tx.media.create({
        data: {
          albumId,
          uploadedById: userId,
          albumDate,
          capturedAt: dto.capturedAt ? new Date(dto.capturedAt) : null,
          dateSource: dto.dateSource ?? "USER",
          clientUploadId: dto.clientUploadId,
          originalName: dto.originalName,
          tempObjectKey: `temp/${album.familyId}/${randomUUID()}`,
          status: "PENDING_UPLOAD",
          childTags: childTagIds.length
            ? { createMany: { data: childTagIds.map((childTagId) => ({ childTagId })) } }
            : undefined
        },
        include: { childTags: { include: { childTag: true } } }
      });
      return {
        media: created,
        expiredMedia
      };
    });

    await Promise.allSettled(
      expiredMedia.map((expiredMedia) => this.cleanupTempObject(
        { ...expiredMedia, status: "DELETED" },
        "UPLOAD_EXPIRED"
      ))
    );

    const childTags = media.childTags.map((item) => item.childTag);
    const metadata = { capturedAt: media.capturedAt, dateSource: media.dateSource };
    if (!media.tempObjectKey || !["PENDING_UPLOAD", "FAILED"].includes(media.status)) {
      return { mediaId: media.id, status: media.status, uploadUrl: null, childTags, ...metadata };
    }
    return {
      mediaId: media.id,
      status: media.status,
      uploadUrl: await this.storage.presignUpload(media.tempObjectKey, dto.contentType, dto.fileSize),
      childTags,
      ...metadata
    };
  }

  async complete(userId: string, mediaId: string) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
      include: { album: true, mediaAsset: true }
    });
    if (!media) throw new NotFoundException({ code: "MEDIA_NOT_FOUND", message: "미디어를 찾을 수 없습니다." });
    await this.albums.requireAlbum(userId, media.albumId);
    if (media.status === "READY") {
      const ready = await this.cleanupTempObject(media);
      return { mediaId: ready.id, status: ready.status };
    }
    if (media.uploadedById !== userId || !media.tempObjectKey) {
      throw new ForbiddenException({ code: "UPLOAD_OWNER_REQUIRED", message: "업로드한 사용자만 완료할 수 있습니다." });
    }

    // ponytail: process-local gate; move processing to a shared queue when API instances scale horizontally.
    const releaseImageProcessingSlot = await acquireImageProcessingSlot();
    try {
    const claimTime = new Date();
    const claimMedia = (tx: PrismaService, allowFailed = false) => tx.media.updateMany({
      where: {
        id: media.id,
        OR: [
          { status: allowFailed ? { in: ["PENDING_UPLOAD", "FAILED"] } : "PENDING_UPLOAD" },
          {
            status: "PROCESSING",
            updatedAt: { lt: new Date(Date.now() - UPLOAD_EXPIRY_MS) }
          }
        ],
        tempObjectKey: { not: null }
      },
      data: { status: "PROCESSING", failureReason: null, updatedAt: claimTime }
    });
    const claimFailedMedia = () => this.prisma.$transaction(async (tx) => {
      const lockKey = `${media.albumId}:${media.albumDate.toISOString().slice(0, 10)}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const activeCount = await tx.media.count({
        where: { albumId: media.albumId, albumDate: media.albumDate, status: { in: [...ACTIVE_STATUSES] } }
      });
      assertDailyMediaCapacity(activeCount);
      return claimMedia(tx as PrismaService, true);
    });
    let claim = media.status === "FAILED"
      ? await claimFailedMedia()
      : await claimMedia(this.prisma);
    if (claim.count === 0) {
      const current = await this.prisma.media.findUnique({
        where: { id: media.id },
        include: { album: true, mediaAsset: true }
      });
      if (current?.status === "READY") {
        const ready = await this.cleanupTempObject(current);
        return { mediaId: ready.id, status: ready.status };
      }
      if (current?.status === "FAILED" && current.tempObjectKey) {
        claim = await claimFailedMedia();
      }
    }
    if (claim.count === 0) {
      throw new ConflictException({
        code: "MEDIA_PROCESSING",
        message: "미디어를 이미 처리하고 있습니다."
      });
    }
    try {
      const source = await this.storage.read(media.tempObjectKey);
      const sha256 = createHash("sha256").update(source.bytes).digest("hex");
      const prefix = `assets/${media.album.familyId}/${sha256}`;
      let mimeType: string;
      let width: number;
      let height: number;
      let display: Buffer | null;
      let thumbnail: Buffer;
      let originalKey: string;
      let displayKey: string;
      const thumbnailKey = `${prefix}/thumbnail.webp`;

      if (source.contentType === "video/mp4") {
        try {
          const video = await processMp4(source.bytes);
          mimeType = video.mimeType;
          width = video.width;
          height = video.height;
          thumbnail = video.thumbnail;
        } catch (error) {
          if (error instanceof VideoProcessorUnavailableError) {
            throw new ServiceUnavailableException({
              code: "VIDEO_PROCESSOR_UNAVAILABLE",
              message: "영상 처리기를 사용할 수 없습니다. 잠시 후 다시 시도해주세요."
            });
          }
          if (error instanceof InvalidVideoError) {
            throw new BadRequestException({
              code: "INVALID_VIDEO",
              message: "H.264 영상과 AAC 음성을 사용하는 MP4 파일만 올릴 수 있습니다."
            });
          }
          throw error;
        }
        originalKey = `${prefix}/original.mp4`;
        displayKey = originalKey;
        display = null;
      } else {
        let metadata;
        try {
          metadata = await sharp(source.bytes, {
            failOn: "error",
            limitInputPixels: MAX_IMAGE_PIXELS
          }).metadata();
        } catch {
          throw new BadRequestException({ code: "INVALID_IMAGE", message: "올바른 이미지 파일이 아닙니다." });
        }
        if (!metadata.width || !metadata.height || !metadata.format) {
          throw new BadRequestException({ code: "INVALID_IMAGE", message: "올바른 이미지 파일이 아닙니다." });
        }
        if (!["jpeg", "png", "webp"].includes(metadata.format)) {
          throw new BadRequestException({
            code: "UNSUPPORTED_IMAGE_FORMAT",
            message: "JPG, PNG, WebP 사진 또는 MP4 영상만 올릴 수 있습니다."
          });
        }
        if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
          throw new BadRequestException({
            code: "IMAGE_TOO_LARGE",
            message: "이미지 해상도가 너무 큽니다."
          });
        }

        const sharpOptions = {
          failOn: "error" as const,
          limitInputPixels: MAX_IMAGE_PIXELS,
          sequentialRead: true
        };
        try {
          display = await sharp(source.bytes, sharpOptions)
            .rotate()
            .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 84 })
            .toBuffer();
          thumbnail = await sharp(source.bytes, sharpOptions)
            .rotate()
            .resize(320, 320, { fit: "cover" })
            .webp({ quality: 78 })
            .toBuffer();
        } catch {
          throw new BadRequestException({ code: "INVALID_IMAGE", message: "올바른 이미지 파일이 아닙니다." });
        }
        mimeType = `image/${metadata.format}`;
        width = metadata.width;
        height = metadata.height;
        originalKey = `${prefix}/original`;
        displayKey = `${prefix}/display.webp`;
      }

      const reservation = await this.prisma.$transaction(async (tx) => {
        const assetLockKey = `asset:${media.album.familyId}:${sha256}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assetLockKey}))`;
        let asset = await tx.mediaAsset.upsert({
          where: { familyId_sha256: { familyId: media.album.familyId, sha256 } },
          update: {},
          create: {
            familyId: media.album.familyId,
            sha256,
            mimeType,
            width,
            height,
            originalKey,
            displayKey,
            thumbnailKey,
            status: "ORPHANED"
          }
        });
        if (asset.status === "DELETING") {
          if (asset.updatedAt >= new Date(Date.now() - ASSET_DELETION_EXPIRY_MS)) {
            throw new Error("MEDIA_ASSET_DELETING");
          }
          asset = await tx.mediaAsset.update({
            where: { id: asset.id },
            data: { status: "ORPHANED" }
          });
        }
        const reserved = await tx.media.updateMany({
          where: { id: media.id, status: "PROCESSING", updatedAt: claimTime },
          data: { mediaAssetId: asset.id, updatedAt: claimTime }
        });
        if (reserved.count === 0) {
          throw new ConflictException({
            code: "MEDIA_STATE_CHANGED",
            message: "미디어 상태가 변경되어 처리를 완료하지 않았습니다."
          });
        }
        return { asset, needsUpload: asset.status !== "READY" };
      });
      if (reservation.needsUpload) {
        await Promise.all([
          this.storage.put(originalKey, source.bytes, mimeType),
          ...(display ? [this.storage.put(displayKey, display, "image/webp")] : []),
          this.storage.put(thumbnailKey, thumbnail, "image/webp")
        ]);
      }
      const ready = await this.prisma.$transaction(async (tx) => {
        const assetLockKey = `asset:${media.album.familyId}:${sha256}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assetLockKey}))`;
        const lockKey = `${media.albumId}:${media.albumDate.toISOString().slice(0, 10)}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        await tx.mediaAsset.update({
          where: { id: reservation.asset.id },
          data: { status: "READY" }
        });
        const committed = await tx.media.updateMany({
          where: { id: media.id, status: "PROCESSING", updatedAt: claimTime },
          data: { mediaAssetId: reservation.asset.id, status: "READY", failureReason: null }
        });
        if (committed.count === 0) {
          throw new ConflictException({
            code: "MEDIA_STATE_CHANGED",
            message: "미디어 상태가 변경되어 처리를 완료하지 않았습니다."
          });
        }
        const completed = await tx.media.findUnique({
          where: { id: media.id },
          include: { mediaAsset: true }
        });
        if (!completed) throw new Error("MEDIA_COMMIT_LOST");
        await tx.dailyRepresentative.upsert({
          where: { albumId_albumDate: { albumId: media.albumId, albumDate: media.albumDate } },
          update: {},
          create: { albumId: media.albumId, albumDate: media.albumDate, mediaId: media.id }
        });
        return completed;
      });
      const completed = await this.cleanupTempObject(ready);
      return { mediaId: completed.id, status: completed.status };
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof ConflictException) throw error;
      const inputError =
        error instanceof BadRequestException
          ? error
          : error instanceof StorageObjectError
            ? new BadRequestException({
                code: error.code,
                message: error.code === "FILE_TOO_LARGE"
                  ? "사진은 20MB, 영상은 200MB까지 업로드할 수 있습니다."
                  : "업로드한 파일이 비어 있습니다."
              })
            : null;
      const response = inputError?.getResponse() ?? null;
      const reason =
        response && typeof response === "object" && "code" in response && typeof response.code === "string"
          ? response.code
          : "MEDIA_PROCESSING_FAILED";
      let failed;
      try {
        failed = await this.prisma.media.updateMany({
          where: { id: media.id, status: "PROCESSING", updatedAt: claimTime },
          data: { status: "FAILED", failureReason: reason }
        });
      } catch {
        throw new ServiceUnavailableException({
          code: "MEDIA_PROCESSING_FAILED",
          message: "파일 처리 상태를 저장하지 못했습니다. 잠시 후 다시 시도해주세요."
        });
      }
      if (failed.count === 0) {
        throw new ConflictException({
          code: "MEDIA_STATE_CHANGED",
          message: "미디어 상태가 변경되어 실패 상태를 저장하지 않았습니다."
        });
      }
      if (inputError) throw inputError;
      throw new ServiceUnavailableException({
        code: "MEDIA_PROCESSING_FAILED",
        message: "파일 처리에 실패했습니다. 잠시 후 다시 시도해주세요."
      });
    }
    } finally {
      releaseImageProcessingSlot();
    }
  }

  private async cleanupTempObject(
    media: { id: string; tempObjectKey: string | null; status: string },
    failureReason: string | null = null
  ) {
    if (!media.tempObjectKey) return media;
    try {
      await this.storage.delete(media.tempObjectKey);
      return await this.prisma.media.update({
        where: { id: media.id },
        data: { tempObjectKey: null, failureReason },
        include: { album: true, mediaAsset: true }
      });
    } catch {
      await this.prisma.media.update({
        where: { id: media.id },
        data: { failureReason: failureReason ?? "TEMP_OBJECT_CLEANUP_PENDING" }
      }).catch(() => undefined);
      throw new ServiceUnavailableException({
        code: "MEDIA_CLEANUP_FAILED",
        message: "임시 파일 정리를 완료하지 못했습니다. 잠시 후 다시 시도해주세요."
      });
    }
  }

  private async cleanupMediaAsset(mediaAssetId: string | null | undefined): Promise<void> {
    if (!mediaAssetId) return;
    const candidate = await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.mediaAsset.findUnique({ where: { id: mediaAssetId } });
      if (!candidate) return null;
      const lockKey = `asset:${candidate.familyId}:${candidate.sha256}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const asset = await tx.mediaAsset.findUnique({ where: { id: mediaAssetId } });
      if (!asset) return null;
      const activeReferences = await tx.media.count({
        where: { mediaAssetId, status: { not: "DELETED" } }
      });
      if (activeReferences > 0) {
        await tx.media.updateMany({
          where: { mediaAssetId, status: "DELETED" },
          data: { mediaAssetId: null }
        });
        return null;
      }
      return tx.mediaAsset.update({
        where: { id: mediaAssetId },
        data: { status: "DELETING" }
      });
    });
    if (!candidate) return;

    const deleted = await Promise.allSettled(
      [...new Set([candidate.originalKey, candidate.displayKey, candidate.thumbnailKey])]
        .map((key) => this.storage.delete(key))
    );
    if (deleted.some(({ status }) => status === "rejected")) {
      await this.prisma.mediaAsset.updateMany({
        where: { id: mediaAssetId, status: "DELETING" },
        data: { status: "ORPHANED" }
      });
      throw new ServiceUnavailableException({
        code: "MEDIA_CLEANUP_FAILED",
        message: "미디어 파일을 완전히 삭제하지 못했습니다. 잠시 후 다시 시도해주세요."
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const lockKey = `asset:${candidate.familyId}:${candidate.sha256}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const asset = await tx.mediaAsset.findUnique({ where: { id: mediaAssetId } });
      if (!asset || asset.status !== "DELETING") return;
      await tx.media.updateMany({
        where: { mediaAssetId, status: "DELETED" },
        data: { mediaAssetId: null }
      });
      await tx.mediaAsset.delete({ where: { id: mediaAssetId } });
    });
  }

  async list(
    userId: string,
    albumId: string,
    date: string,
    filter: MediaFilter = EMPTY_MEDIA_FILTER
  ) {
    await this.albums.requireAlbum(userId, albumId);
    const albumDate = parseAlbumDate(date);
    const rows = await this.prisma.media.findMany({
      where: {
        albumId,
        albumDate,
        status: "READY",
        ...mediaFilterWhere(filter)
      },
      select: {
        id: true,
        albumDate: true,
        originalName: true,
        uploadedById: true,
        createdAt: true,
        mediaAsset: { select: { width: true, height: true, mimeType: true } },
        childTags: { select: { childTag: true } }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30
    });
    return rows.map(({ childTags, ...media }) => ({
      ...media,
      childTags: childTags.map((item) => item.childTag)
    }));
  }

  async feed(
    userId: string,
    albumId: string,
    filter: MediaFilter = EMPTY_MEDIA_FILTER,
    cursor?: string,
    take = 40
  ) {
    await this.albums.requireAlbum(userId, albumId);
    const pageSize = Number.isFinite(take) ? Math.min(Math.max(Math.trunc(take), 1), 60) : 40;
    const rows = await this.prisma.media.findMany({
      where: {
        albumId,
        status: "READY",
        ...mediaFilterWhere(filter)
      },
      select: {
        id: true,
        albumDate: true,
        originalName: true,
        uploadedById: true,
        createdAt: true,
        mediaAsset: { select: { width: true, height: true, mimeType: true } },
        childTags: { select: { childTag: true } }
      },
      orderBy: [{ albumDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const items = rows.slice(0, pageSize).map(({ childTags, ...media }) => ({
      ...media,
      childTags: childTags.map((item) => item.childTag)
    }));
    return {
      items,
      nextCursor: rows.length > pageSize ? items.at(-1)?.id ?? null : null
    };
  }

  async url(userId: string, mediaId: string, variant: "thumbnail" | "display" | "original") {
    if (!["thumbnail", "display", "original"].includes(variant)) {
      throw new BadRequestException({
        code: "INVALID_MEDIA_VARIANT",
        message: "지원하지 않는 이미지 형식입니다."
      });
    }
    const media = await this.prisma.media.findFirst({
      where: {
        id: mediaId,
        status: "READY",
        mediaAsset: { is: { status: "READY" } },
        album: { family: { members: { some: { userId } } } }
      },
      select: {
        originalName: true,
        mediaAsset: {
          select: { originalKey: true, displayKey: true, thumbnailKey: true }
        }
      }
    });
    if (!media?.mediaAsset) {
      throw new NotFoundException({ code: "MEDIA_NOT_FOUND", message: "미디어를 찾을 수 없습니다." });
    }
    const key = variant === "thumbnail"
      ? media.mediaAsset.thumbnailKey
      : variant === "display"
        ? media.mediaAsset.displayKey
        : media.mediaAsset.originalKey;
    return { url: await this.storage.presignDownload(key, variant === "original" ? media.originalName : undefined) };
  }

  async setRepresentative(userId: string, albumId: string, date: string, mediaId: string) {
    const { membership } = await this.albums.requireAlbum(userId, albumId);
    if (membership.role !== "OWNER") {
      throw new ForbiddenException({ code: "OWNER_REQUIRED", message: "가족 대표만 설정할 수 있습니다." });
    }
    const albumDate = parseAlbumDate(date);
    return this.prisma.$transaction(async (tx) => {
      const lockKey = `${albumId}:${date}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const media = await tx.media.findFirst({
        where: { id: mediaId, albumId, albumDate, status: "READY" }
      });
      if (!media) {
        throw new BadRequestException({
          code: "INVALID_REPRESENTATIVE",
          message: "해당 날짜의 준비된 사진이나 영상만 선택할 수 있습니다."
        });
      }
      return tx.dailyRepresentative.upsert({
        where: { albumId_albumDate: { albumId, albumDate } },
        update: { mediaId },
        create: { albumId, albumDate, mediaId }
      });
    });
  }

  async remove(userId: string, mediaId: string) {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException({ code: "MEDIA_NOT_FOUND", message: "미디어를 찾을 수 없습니다." });
    const { membership } = await this.albums.requireAlbum(userId, media.albumId);
    if (!canDeleteMedia(membership.role, userId, media.uploadedById)) {
      throw new ForbiddenException({ code: "DELETE_FORBIDDEN", message: "본인이 올린 사진이나 영상만 삭제할 수 있습니다." });
    }
    if (media.status === "PROCESSING") {
      throw new ConflictException({
        code: "MEDIA_PROCESSING",
        message: "미디어 처리가 끝난 후 다시 시도해주세요."
      });
    }
    if (media.status !== "DELETED") {
      await this.prisma.$transaction(async (tx) => {
        const lockKey = `${media.albumId}:${media.albumDate.toISOString().slice(0, 10)}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const deleted = await tx.media.updateMany({
          where: {
            id: mediaId,
            status: { in: ["PENDING_UPLOAD", "FAILED", "READY"] }
          },
          data: { status: "DELETED" }
        });
        if (deleted.count === 0) {
          throw new ConflictException({
            code: "MEDIA_STATE_CHANGED",
            message: "미디어 상태가 변경되어 삭제하지 않았습니다."
          });
        }
        const removedRepresentative = await tx.dailyRepresentative.deleteMany({ where: { mediaId } });
        if (removedRepresentative.count > 0) {
          const replacement = await tx.media.findFirst({
            where: { albumId: media.albumId, albumDate: media.albumDate, status: "READY", id: { not: mediaId } },
            orderBy: { createdAt: "desc" }
          });
          if (replacement) {
            await tx.dailyRepresentative.create({
              data: { albumId: media.albumId, albumDate: media.albumDate, mediaId: replacement.id }
            });
          }
        }
      });
    }
    let cleanupPending = false;
    try {
      await this.cleanupTempObject(media);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      cleanupPending = true;
    }
    try {
      await this.cleanupMediaAsset(media.mediaAssetId);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      cleanupPending = true;
    }
    return cleanupPending ? { ok: true, cleanupPending: true } : { ok: true };
  }
}
