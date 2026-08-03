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
  EMPTY_PHOTO_FILTER,
  photoFilterWhere,
  type PhotoFilter
} from "../common/photo-filter.js";
import { AlbumsService } from "../albums/albums.service.js";
import { assertDailyPhotoCapacity, canDeletePhoto } from "./policies.js";
import { StorageObjectError, StorageService } from "./storage.service.js";
import type { StartUploadDto } from "./photos.dto.js";

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
export class PhotosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PhotosService.name);
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly albums: AlbumsService,
    private readonly storage: StorageService
  ) {}

  onModuleInit(): void {
    // ponytail: each API replica runs this idempotent DB-backed sweep; use a dedicated worker only if cleanup volume grows.
    this.cleanupTimer = setInterval(() => void this.cleanupAbandonedPhotos(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    void this.cleanupAbandonedPhotos();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async cleanupAbandonedPhotos(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const uploadCutoff = new Date(Date.now() - UPLOAD_EXPIRY_MS);
      const deletionCutoff = new Date(Date.now() - ASSET_DELETION_EXPIRY_MS);
      const photos = await this.prisma.photo.findMany({
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
      for (const photo of photos) {
        if (photo.status === "READY") {
          try {
            await this.cleanupTempObject(photo);
          } catch (error) {
            if (!(error instanceof ServiceUnavailableException)) throw error;
          }
          continue;
        }
        const expiredUpload = photo.status !== "DELETED" || photo.failureReason === "UPLOAD_EXPIRED";
        if (photo.status !== "DELETED") {
          const claimed = await this.prisma.photo.updateMany({
            where: { id: photo.id, status: photo.status, updatedAt: { lt: uploadCutoff } },
            data: { status: "DELETED", failureReason: "UPLOAD_EXPIRED" }
          });
          if (claimed.count === 0) continue;
        }
        let cleanupPending = false;
        try {
          await this.cleanupTempObject(photo, expiredUpload ? "UPLOAD_EXPIRED" : null);
        } catch (error) {
          if (!(error instanceof ServiceUnavailableException)) throw error;
          cleanupPending = true;
        }
        try {
          await this.cleanupMediaAsset(photo.mediaAssetId);
        } catch (error) {
          if (!(error instanceof ServiceUnavailableException)) throw error;
          cleanupPending = true;
        }
        if (cleanupPending) {
          await this.prisma.photo.updateMany({
            where: { id: photo.id, status: "DELETED" },
            data: { failureReason: expiredUpload ? "UPLOAD_EXPIRED" : "PHOTO_CLEANUP_PENDING" }
          });
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logger.warn(`보류된 사진 정리를 완료하지 못했습니다. 다음 주기에 다시 시도합니다: ${cause}`);
    } finally {
      this.cleanupRunning = false;
    }
  }

  async startUpload(userId: string, albumId: string, dto: StartUploadDto) {
    const { album } = await this.albums.requireAlbum(userId, albumId);
    const childTagIds = [...new Set(dto.childTagIds ?? [])];
    const albumDate = parseAlbumDate(dto.date);

    const { photo, expiredPhotos } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${albumId}:${dto.date}`}))`;
      let existing = await tx.photo.findUnique({
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
          const activeCount = await tx.photo.count({
            where: { albumId, albumDate, status: { in: [...ACTIVE_STATUSES] } }
          });
          assertDailyPhotoCapacity(activeCount);
        }
        if (retryExpiredUpload) {
          existing = await tx.photo.update({
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
          photo: existing,
          expiredPhotos: [] as Array<{ id: string; tempObjectKey: string | null }>
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
      const stale = await tx.photo.findMany({
        where: {
          albumId,
          albumDate,
          status: { in: ["PENDING_UPLOAD", "PROCESSING"] },
          updatedAt: { lt: uploadCutoff }
        },
        select: { id: true, tempObjectKey: true }
      });
      const expiredPhotos: typeof stale = [];
      for (const candidate of stale) {
        const expired = await tx.photo.updateMany({
          where: {
            id: candidate.id,
            status: { in: ["PENDING_UPLOAD", "PROCESSING"] },
            updatedAt: { lt: uploadCutoff }
          },
          data: { status: "DELETED", failureReason: "UPLOAD_EXPIRED" }
        });
        if (expired.count) expiredPhotos.push(candidate);
      }
      const activeCount = await tx.photo.count({
        where: { albumId, albumDate, status: { in: [...ACTIVE_STATUSES] } }
      });
      assertDailyPhotoCapacity(activeCount);
      const created = await tx.photo.create({
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
        photo: created,
        expiredPhotos
      };
    });

    await Promise.allSettled(
      expiredPhotos.map((expiredPhoto) => this.cleanupTempObject(
        { ...expiredPhoto, status: "DELETED" },
        "UPLOAD_EXPIRED"
      ))
    );

    const childTags = photo.childTags.map((item) => item.childTag);
    const metadata = { capturedAt: photo.capturedAt, dateSource: photo.dateSource };
    if (!photo.tempObjectKey || !["PENDING_UPLOAD", "FAILED"].includes(photo.status)) {
      return { photoId: photo.id, status: photo.status, uploadUrl: null, childTags, ...metadata };
    }
    return {
      photoId: photo.id,
      status: photo.status,
      uploadUrl: await this.storage.presignUpload(photo.tempObjectKey, dto.contentType, dto.fileSize),
      childTags,
      ...metadata
    };
  }

  async complete(userId: string, photoId: string) {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: { album: true, mediaAsset: true }
    });
    if (!photo) throw new NotFoundException({ code: "PHOTO_NOT_FOUND", message: "사진을 찾을 수 없습니다." });
    await this.albums.requireAlbum(userId, photo.albumId);
    if (photo.status === "READY") {
      const ready = await this.cleanupTempObject(photo);
      return { photoId: ready.id, status: ready.status };
    }
    if (photo.uploadedById !== userId || !photo.tempObjectKey) {
      throw new ForbiddenException({ code: "UPLOAD_OWNER_REQUIRED", message: "업로드한 사용자만 완료할 수 있습니다." });
    }

    // ponytail: process-local gate; move processing to a shared queue when API instances scale horizontally.
    const releaseImageProcessingSlot = await acquireImageProcessingSlot();
    try {
    const claimTime = new Date();
    const claimPhoto = (tx: PrismaService, allowFailed = false) => tx.photo.updateMany({
      where: {
        id: photo.id,
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
    const claimFailedPhoto = () => this.prisma.$transaction(async (tx) => {
      const lockKey = `${photo.albumId}:${photo.albumDate.toISOString().slice(0, 10)}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const activeCount = await tx.photo.count({
        where: { albumId: photo.albumId, albumDate: photo.albumDate, status: { in: [...ACTIVE_STATUSES] } }
      });
      assertDailyPhotoCapacity(activeCount);
      return claimPhoto(tx as PrismaService, true);
    });
    let claim = photo.status === "FAILED"
      ? await claimFailedPhoto()
      : await claimPhoto(this.prisma);
    if (claim.count === 0) {
      const current = await this.prisma.photo.findUnique({
        where: { id: photo.id },
        include: { album: true, mediaAsset: true }
      });
      if (current?.status === "READY") {
        const ready = await this.cleanupTempObject(current);
        return { photoId: ready.id, status: ready.status };
      }
      if (current?.status === "FAILED" && current.tempObjectKey) {
        claim = await claimFailedPhoto();
      }
    }
    if (claim.count === 0) {
      throw new ConflictException({
        code: "PHOTO_PROCESSING",
        message: "사진을 이미 처리하고 있습니다."
      });
    }
    try {
      const source = await this.storage.read(photo.tempObjectKey);
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
          message: "JPG, PNG, WebP 사진만 올릴 수 있습니다."
        });
      }
      if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
        throw new BadRequestException({
          code: "IMAGE_TOO_LARGE",
          message: "이미지 해상도가 너무 큽니다."
        });
      }

      const sha256 = createHash("sha256").update(source.bytes).digest("hex");
      const prefix = `assets/${photo.album.familyId}/${sha256}`;
      const sharpOptions = {
        failOn: "error" as const,
        limitInputPixels: MAX_IMAGE_PIXELS,
        sequentialRead: true
      };
      let display: Buffer;
      let thumbnail: Buffer;
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
      const originalKey = `${prefix}/original`;
      const displayKey = `${prefix}/display.webp`;
      const thumbnailKey = `${prefix}/thumbnail.webp`;

      const reservation = await this.prisma.$transaction(async (tx) => {
        const assetLockKey = `asset:${photo.album.familyId}:${sha256}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assetLockKey}))`;
        let asset = await tx.mediaAsset.upsert({
          where: { familyId_sha256: { familyId: photo.album.familyId, sha256 } },
          update: {},
          create: {
            familyId: photo.album.familyId,
            sha256,
            mimeType: `image/${metadata.format}`,
            width: metadata.width,
            height: metadata.height,
            originalKey,
            displayKey,
            thumbnailKey,
            status: "ORPHANED"
          }
        });
        if (asset.status === "DELETING") {
          if (asset.updatedAt >= new Date(Date.now() - ASSET_DELETION_EXPIRY_MS)) {
            throw new Error("PHOTO_ASSET_DELETING");
          }
          asset = await tx.mediaAsset.update({
            where: { id: asset.id },
            data: { status: "ORPHANED" }
          });
        }
        const reserved = await tx.photo.updateMany({
          where: { id: photo.id, status: "PROCESSING", updatedAt: claimTime },
          data: { mediaAssetId: asset.id, updatedAt: claimTime }
        });
        if (reserved.count === 0) {
          throw new ConflictException({
            code: "PHOTO_STATE_CHANGED",
            message: "사진 상태가 변경되어 처리를 완료하지 않았습니다."
          });
        }
        return { asset, needsUpload: asset.status !== "READY" };
      });
      if (reservation.needsUpload) {
        await Promise.all([
          this.storage.put(originalKey, source.bytes, `image/${metadata.format}`),
          this.storage.put(displayKey, display, "image/webp"),
          this.storage.put(thumbnailKey, thumbnail, "image/webp")
        ]);
      }
      const ready = await this.prisma.$transaction(async (tx) => {
        const assetLockKey = `asset:${photo.album.familyId}:${sha256}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assetLockKey}))`;
        const lockKey = `${photo.albumId}:${photo.albumDate.toISOString().slice(0, 10)}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        await tx.mediaAsset.update({
          where: { id: reservation.asset.id },
          data: { status: "READY" }
        });
        const committed = await tx.photo.updateMany({
          where: { id: photo.id, status: "PROCESSING", updatedAt: claimTime },
          data: { mediaAssetId: reservation.asset.id, status: "READY", failureReason: null }
        });
        if (committed.count === 0) {
          throw new ConflictException({
            code: "PHOTO_STATE_CHANGED",
            message: "사진 상태가 변경되어 처리를 완료하지 않았습니다."
          });
        }
        const completed = await tx.photo.findUnique({
          where: { id: photo.id },
          include: { mediaAsset: true }
        });
        if (!completed) throw new Error("PHOTO_COMMIT_LOST");
        await tx.dailyRepresentative.upsert({
          where: { albumId_albumDate: { albumId: photo.albumId, albumDate: photo.albumDate } },
          update: {},
          create: { albumId: photo.albumId, albumDate: photo.albumDate, photoId: photo.id }
        });
        return completed;
      });
      const completed = await this.cleanupTempObject(ready);
      return { photoId: completed.id, status: completed.status };
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof ConflictException) throw error;
      const inputError =
        error instanceof BadRequestException
          ? error
          : error instanceof StorageObjectError
            ? new BadRequestException({
                code: error.code,
                message: error.code === "FILE_TOO_LARGE" ? "사진은 최대 20MB까지 업로드할 수 있습니다." : "사진 파일이 비어 있습니다."
              })
            : null;
      const response = inputError?.getResponse() ?? null;
      const reason =
        response && typeof response === "object" && "code" in response && typeof response.code === "string"
          ? response.code
          : "PHOTO_PROCESSING_FAILED";
      let failed;
      try {
        failed = await this.prisma.photo.updateMany({
          where: { id: photo.id, status: "PROCESSING", updatedAt: claimTime },
          data: { status: "FAILED", failureReason: reason }
        });
      } catch {
        throw new ServiceUnavailableException({
          code: "PHOTO_PROCESSING_FAILED",
          message: "사진 처리 상태를 저장하지 못했습니다. 잠시 후 다시 시도해주세요."
        });
      }
      if (failed.count === 0) {
        throw new ConflictException({
          code: "PHOTO_STATE_CHANGED",
          message: "사진 상태가 변경되어 실패 상태를 저장하지 않았습니다."
        });
      }
      if (inputError) throw inputError;
      throw new ServiceUnavailableException({
        code: "PHOTO_PROCESSING_FAILED",
        message: "사진 처리에 실패했습니다. 잠시 후 다시 시도해주세요."
      });
    }
    } finally {
      releaseImageProcessingSlot();
    }
  }

  private async cleanupTempObject(
    photo: { id: string; tempObjectKey: string | null; status: string },
    failureReason: string | null = null
  ) {
    if (!photo.tempObjectKey) return photo;
    try {
      await this.storage.delete(photo.tempObjectKey);
      return await this.prisma.photo.update({
        where: { id: photo.id },
        data: { tempObjectKey: null, failureReason },
        include: { album: true, mediaAsset: true }
      });
    } catch {
      await this.prisma.photo.update({
        where: { id: photo.id },
        data: { failureReason: failureReason ?? "TEMP_OBJECT_CLEANUP_PENDING" }
      }).catch(() => undefined);
      throw new ServiceUnavailableException({
        code: "PHOTO_CLEANUP_FAILED",
        message: "임시 사진 정리를 완료하지 못했습니다. 잠시 후 다시 시도해주세요."
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
      const activeReferences = await tx.photo.count({
        where: { mediaAssetId, status: { not: "DELETED" } }
      });
      if (activeReferences > 0) {
        await tx.photo.updateMany({
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

    const deleted = await Promise.allSettled([
      this.storage.delete(candidate.originalKey),
      this.storage.delete(candidate.displayKey),
      this.storage.delete(candidate.thumbnailKey)
    ]);
    if (deleted.some(({ status }) => status === "rejected")) {
      await this.prisma.mediaAsset.updateMany({
        where: { id: mediaAssetId, status: "DELETING" },
        data: { status: "ORPHANED" }
      });
      throw new ServiceUnavailableException({
        code: "PHOTO_CLEANUP_FAILED",
        message: "사진 파일을 완전히 삭제하지 못했습니다. 잠시 후 다시 시도해주세요."
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const lockKey = `asset:${candidate.familyId}:${candidate.sha256}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const asset = await tx.mediaAsset.findUnique({ where: { id: mediaAssetId } });
      if (!asset || asset.status !== "DELETING") return;
      await tx.photo.updateMany({
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
    filter: PhotoFilter = EMPTY_PHOTO_FILTER
  ) {
    await this.albums.requireAlbum(userId, albumId);
    const albumDate = parseAlbumDate(date);
    const rows = await this.prisma.photo.findMany({
      where: {
        albumId,
        albumDate,
        status: "READY",
        ...photoFilterWhere(filter)
      },
      select: {
        id: true,
        albumDate: true,
        originalName: true,
        uploadedById: true,
        createdAt: true,
        mediaAsset: { select: { width: true, height: true } },
        childTags: { select: { childTag: true } }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30
    });
    return rows.map(({ childTags, ...photo }) => ({
      ...photo,
      childTags: childTags.map((item) => item.childTag)
    }));
  }

  async feed(
    userId: string,
    albumId: string,
    filter: PhotoFilter = EMPTY_PHOTO_FILTER,
    cursor?: string,
    take = 40
  ) {
    await this.albums.requireAlbum(userId, albumId);
    const pageSize = Number.isFinite(take) ? Math.min(Math.max(Math.trunc(take), 1), 60) : 40;
    const rows = await this.prisma.photo.findMany({
      where: {
        albumId,
        status: "READY",
        ...photoFilterWhere(filter)
      },
      select: {
        id: true,
        albumDate: true,
        originalName: true,
        uploadedById: true,
        createdAt: true,
        mediaAsset: { select: { width: true, height: true } },
        childTags: { select: { childTag: true } }
      },
      orderBy: [{ albumDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const items = rows.slice(0, pageSize).map(({ childTags, ...photo }) => ({
      ...photo,
      childTags: childTags.map((item) => item.childTag)
    }));
    return {
      items,
      nextCursor: rows.length > pageSize ? items.at(-1)?.id ?? null : null
    };
  }

  async url(userId: string, photoId: string, variant: "thumbnail" | "display" | "original") {
    if (!["thumbnail", "display", "original"].includes(variant)) {
      throw new BadRequestException({
        code: "INVALID_PHOTO_VARIANT",
        message: "지원하지 않는 이미지 형식입니다."
      });
    }
    const photo = await this.prisma.photo.findFirst({
      where: {
        id: photoId,
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
    if (!photo?.mediaAsset) {
      throw new NotFoundException({ code: "PHOTO_NOT_FOUND", message: "사진을 찾을 수 없습니다." });
    }
    const key = variant === "thumbnail"
      ? photo.mediaAsset.thumbnailKey
      : variant === "display"
        ? photo.mediaAsset.displayKey
        : photo.mediaAsset.originalKey;
    return { url: await this.storage.presignDownload(key, variant === "original" ? photo.originalName : undefined) };
  }

  async setRepresentative(userId: string, albumId: string, date: string, photoId: string) {
    const { membership } = await this.albums.requireAlbum(userId, albumId);
    if (membership.role !== "OWNER") {
      throw new ForbiddenException({ code: "OWNER_REQUIRED", message: "가족 대표만 설정할 수 있습니다." });
    }
    const albumDate = parseAlbumDate(date);
    return this.prisma.$transaction(async (tx) => {
      const lockKey = `${albumId}:${date}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const photo = await tx.photo.findFirst({
        where: { id: photoId, albumId, albumDate, status: "READY" }
      });
      if (!photo) {
        throw new BadRequestException({
          code: "INVALID_REPRESENTATIVE",
          message: "해당 날짜의 준비된 사진만 선택할 수 있습니다."
        });
      }
      return tx.dailyRepresentative.upsert({
        where: { albumId_albumDate: { albumId, albumDate } },
        update: { photoId },
        create: { albumId, albumDate, photoId }
      });
    });
  }

  async remove(userId: string, photoId: string) {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo) throw new NotFoundException({ code: "PHOTO_NOT_FOUND", message: "사진을 찾을 수 없습니다." });
    const { membership } = await this.albums.requireAlbum(userId, photo.albumId);
    if (!canDeletePhoto(membership.role, userId, photo.uploadedById)) {
      throw new ForbiddenException({ code: "DELETE_FORBIDDEN", message: "본인이 올린 사진만 삭제할 수 있습니다." });
    }
    if (photo.status === "PROCESSING") {
      throw new ConflictException({
        code: "PHOTO_PROCESSING",
        message: "사진 처리가 끝난 후 다시 시도해주세요."
      });
    }
    if (photo.status !== "DELETED") {
      await this.prisma.$transaction(async (tx) => {
        const lockKey = `${photo.albumId}:${photo.albumDate.toISOString().slice(0, 10)}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const deleted = await tx.photo.updateMany({
          where: {
            id: photoId,
            status: { in: ["PENDING_UPLOAD", "FAILED", "READY"] }
          },
          data: { status: "DELETED" }
        });
        if (deleted.count === 0) {
          throw new ConflictException({
            code: "PHOTO_STATE_CHANGED",
            message: "사진 상태가 변경되어 삭제하지 않았습니다."
          });
        }
        const removedRepresentative = await tx.dailyRepresentative.deleteMany({ where: { photoId } });
        if (removedRepresentative.count > 0) {
          const replacement = await tx.photo.findFirst({
            where: { albumId: photo.albumId, albumDate: photo.albumDate, status: "READY", id: { not: photoId } },
            orderBy: { createdAt: "desc" }
          });
          if (replacement) {
            await tx.dailyRepresentative.create({
              data: { albumId: photo.albumId, albumDate: photo.albumDate, photoId: replacement.id }
            });
          }
        }
      });
    }
    let cleanupPending = false;
    try {
      await this.cleanupTempObject(photo);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      cleanupPending = true;
    }
    try {
      await this.cleanupMediaAsset(photo.mediaAssetId);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      cleanupPending = true;
    }
    return cleanupPending ? { ok: true, cleanupPending: true } : { ok: true };
  }
}
