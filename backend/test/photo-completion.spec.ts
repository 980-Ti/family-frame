import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AlbumsService } from "../src/albums/albums.service.js";
import { PrismaService } from "../src/common/prisma.service.js";
import { FamiliesService } from "../src/families/families.service.js";
import { PhotosService } from "../src/photos/photos.service.js";
import { StorageService } from "../src/photos/storage.service.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

describe("photo completion recovery", () => {
  it("keeps a partially written media asset linked for retry or deletion", async () => {
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      mimeType: "image/png",
      width: 1,
      height: 1,
      originalKey: "assets/family-1/hash/original",
      displayKey: "assets/family-1/hash/display.webp",
      thumbnailKey: "assets/family-1/hash/thumbnail.webp",
      status: "ORPHANED"
    };
    let storedAsset: typeof asset | null = null;
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      originalName: "baby.png",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null as string | null,
      status: "PENDING_UPLOAD",
      album: { familyId: "family-1" },
      mediaAsset: null
    };
    const updatePhoto = (data: Record<string, unknown>) => {
      Object.assign(photo, data);
      return { ...photo, mediaAsset: storedAsset };
    };
    const transaction = async (work: (tx: unknown) => Promise<unknown>) => work({
      $executeRaw: async () => undefined,
      mediaAsset: {
        findUnique: async () => storedAsset,
        upsert: async () => {
          storedAsset = asset;
          return storedAsset;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(asset, data);
          return asset;
        }
      },
      photo: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        },
        findUnique: async () => ({ ...photo, mediaAsset: storedAsset })
      },
      dailyRepresentative: { upsert: async () => ({ id: "representative-1" }) }
    });
    const prisma = {
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data)
      },
      mediaAsset: {
        findUnique: async () => storedAsset,
        upsert: async () => {
          storedAsset = asset;
          return storedAsset;
        }
      },
      $transaction: transaction
    } as unknown as PrismaService;
    const albums = { requireAlbum: async () => ({ album: photo.album }) } as unknown as AlbumsService;
    let writes = 0;
    const storage = {
      read: async () => ({ bytes: png, contentType: "image/png" }),
      put: async () => {
        if (photo.mediaAssetId !== asset.id) throw new Error("ASSET_NOT_RESERVED");
        writes += 1;
        if (writes === 2) throw new Error("DERIVATIVE_WRITE_FAILED");
      },
      delete: async () => undefined
    } as unknown as StorageService;

    await expect(new PhotosService(prisma, albums, storage).complete("user-1", photo.id))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(photo).toMatchObject({ status: "FAILED", mediaAssetId: asset.id });
    expect(storedAsset).toMatchObject({ status: "ORPHANED" });
  });

  it("can retry when representative selection fails after processing", async () => {
    let representativeFails = true;
    let photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      originalName: "baby.png",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null as string | null,
      failureReason: null as string | null,
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null as { id: string } | null
    };
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      mimeType: "image/png",
      width: 1,
      height: 1,
      originalKey: "assets/family-1/hash/original",
      displayKey: "assets/family-1/hash/display.webp",
      thumbnailKey: "assets/family-1/hash/thumbnail.webp",
      status: "READY"
    };
    const updatePhoto = (data: Record<string, unknown>, target = photo) => {
      Object.assign(target, data);
      target.mediaAsset = target.mediaAssetId ? asset : null;
      return { ...target };
    };
    const prisma = {
      album: { findUnique: async () => photo.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data)
      },
      mediaAsset: {
        findUnique: async () => asset,
        upsert: async () => asset
      },
      dailyRepresentative: {
        upsert: async () => {
          if (representativeFails) {
            representativeFails = false;
            throw new Error("REPRESENTATIVE_WRITE_FAILED");
          }
          return { id: "representative-1" };
        }
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const draft = { ...photo };
        const result = await work({
          $executeRaw: async () => undefined,
          mediaAsset: {
            upsert: async () => asset,
            update: async ({ data }: { data: Record<string, unknown> }) => {
              Object.assign(asset, data);
              return asset;
            }
          },
          photo: {
            count: async () => 0,
            update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data, draft),
            updateMany: async ({ data }: { data: Record<string, unknown> }) => {
              updatePhoto(data, draft);
              return { count: 1 };
            },
            findUnique: async () => ({ ...draft })
          },
          dailyRepresentative: {
            upsert: async () => {
              if (representativeFails) {
                representativeFails = false;
                throw new Error("REPRESENTATIVE_WRITE_FAILED");
              }
              return { id: "representative-1" };
            }
          }
        });
        photo = draft;
        return result;
      }
    } as unknown as PrismaService;
    const storage = {
      read: async () => ({ bytes: png, contentType: "image/png" }),
      put: async () => undefined,
      delete: async () => undefined
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.complete("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "PHOTO_PROCESSING_FAILED"
    });
    await expect(photos.complete("user-1", "photo-1")).resolves.toEqual({
      photoId: "photo-1",
      status: "READY"
    });
  });

  it("does not resurrect a photo deleted during processing", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      originalName: "baby.png",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null as string | null,
      failureReason: null as string | null,
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null as { id: string } | null
    };
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      mimeType: "image/png",
      width: 1,
      height: 1,
      originalKey: "assets/family-1/hash/original",
      displayKey: "assets/family-1/hash/display.webp",
      thumbnailKey: "assets/family-1/hash/thumbnail.webp",
      status: "READY"
    };
    const updatePhoto = (data: Record<string, unknown>) => {
      Object.assign(photo, data);
      photo.mediaAsset = photo.mediaAssetId ? asset : null;
      return { ...photo };
    };
    const prisma = {
      album: { findUnique: async () => photo.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data)
      },
      mediaAsset: {
        findUnique: async () => asset,
        upsert: async () => asset
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        photo.status = "DELETED";
        return work({
          $executeRaw: async () => undefined,
          mediaAsset: {
            upsert: async () => asset,
            update: async ({ data }: { data: Record<string, unknown> }) => {
              Object.assign(asset, data);
              return asset;
            }
          },
          photo: {
            update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data),
            updateMany: async ({ data }: { data: Record<string, unknown> }) => {
              if (photo.status !== "PROCESSING") return { count: 0 };
              updatePhoto(data);
              return { count: 1 };
            },
            findUnique: async () => ({ ...photo })
          },
          dailyRepresentative: { upsert: async () => ({ id: "representative-1" }) }
        });
      }
    } as unknown as PrismaService;
    const deleteObject = vi.fn(async () => undefined);
    const storage = {
      read: async () => ({ bytes: png, contentType: "image/png" }),
      delete: deleteObject
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.complete("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "PHOTO_STATE_CHANGED"
    });
    expect(photo.status).toBe("DELETED");
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("leaves an upload retryable while its matching asset is being deleted", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      originalName: "baby.png",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null as string | null,
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      status: "DELETING",
      updatedAt: new Date()
    };
    const updatePhoto = (data: Record<string, unknown>) => {
      Object.assign(photo, data);
      return { ...photo };
    };
    const tx = {
      $executeRaw: async () => undefined,
      photo: {
        count: async () => 0,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        },
        findUnique: async () => ({ ...photo })
      },
      mediaAsset: { upsert: async () => asset }
    };
    const prisma = {
      photo: {
        findUnique: async () => ({ ...photo }),
        update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        }
      },
      $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx)
    } as unknown as PrismaService;
    const albums = {
      requireAlbum: async () => ({ album: photo.album })
    } as unknown as AlbumsService;
    const put = vi.fn(async () => undefined);
    const storage = {
      read: async () => ({ bytes: png, contentType: "image/png" }),
      put
    } as unknown as StorageService;

    await expect(new PhotosService(prisma, albums, storage).complete("user-1", photo.id))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(photo.status).toBe("FAILED");
    expect(put).not.toHaveBeenCalled();
  });

  it("reclaims an abandoned media-asset deletion when the same photo is uploaded again", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      originalName: "baby.png",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1" as string | null,
      mediaAssetId: null as string | null,
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      originalKey: "assets/family-1/hash/original",
      displayKey: "assets/family-1/hash/display.webp",
      thumbnailKey: "assets/family-1/hash/thumbnail.webp",
      status: "DELETING",
      updatedAt: new Date(0)
    };
    const updatePhoto = (data: Record<string, unknown>) => {
      Object.assign(photo, data);
      return { ...photo, mediaAsset: asset };
    };
    const tx = {
      $executeRaw: async () => undefined,
      mediaAsset: {
        upsert: async () => asset,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(asset, data);
          return asset;
        }
      },
      photo: {
        count: async () => 0,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updatePhoto(data);
          return { count: 1 };
        },
        findUnique: async () => ({ ...photo, mediaAsset: asset })
      },
      dailyRepresentative: { upsert: async () => ({ id: "representative-1" }) }
    };
    const prisma = {
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: tx.photo.updateMany,
        update: async ({ data }: { data: Record<string, unknown> }) => updatePhoto(data)
      },
      $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx)
    } as unknown as PrismaService;
    const albums = { requireAlbum: async () => ({ album: photo.album }) } as unknown as AlbumsService;
    const put = vi.fn(async () => undefined);
    const storage = {
      read: async () => ({ bytes: png, contentType: "image/png" }),
      put,
      delete: async () => undefined
    } as unknown as StorageService;

    await expect(new PhotosService(prisma, albums, storage).complete("user-1", photo.id))
      .resolves.toEqual({ photoId: photo.id, status: "READY" });
    expect(put).toHaveBeenCalledTimes(3);
    expect(asset.status).toBe("READY");
  });

  it("reclaims an abandoned processing upload", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "PROCESSING",
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      tempObjectKey: "temp/family-1/photo-1",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    const read = vi.fn(async () => {
      throw new Error("STORAGE_UNAVAILABLE");
    });
    const prisma = {
      album: { findUnique: async () => photo.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          const candidates = (where.OR ?? []) as { status?: string }[];
          const canReclaim = candidates.some((candidate) => candidate.status === "PROCESSING");
          return { count: canReclaim ? 1 : 0 };
        },
        update: async () => ({ ...photo, status: "FAILED" })
      }
    } as unknown as PrismaService;
    const storage = { read } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await photos.complete("user-1", "photo-1").catch(() => undefined);

    expect(read).toHaveBeenCalledOnce();
  });

  it("does not let a stale worker overwrite a newer completion", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "PROCESSING",
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      tempObjectKey: "temp/family-1/photo-1",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    let claimedAt: Date | undefined;
    const prisma = {
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: async ({ where, data }: {
          where: { OR?: unknown; status?: string; updatedAt?: Date };
          data: { status?: string; updatedAt?: Date };
        }) => {
          if (where.OR) {
            claimedAt = data.updatedAt;
            Object.assign(photo, data);
            return { count: 1 };
          }
          const ownsClaim = photo.status === where.status && photo.updatedAt === where.updatedAt;
          if (ownsClaim) Object.assign(photo, data);
          return { count: ownsClaim ? 1 : 0 };
        },
        update: async ({ data }: { data: { status: string } }) => {
          Object.assign(photo, data);
          return photo;
        }
      }
    } as unknown as PrismaService;
    const albums = { requireAlbum: async () => ({ album: photo.album }) } as unknown as AlbumsService;
    const storage = {
      read: async () => {
        photo.status = "READY";
        photo.updatedAt = new Date((claimedAt?.getTime() ?? 0) + 1);
        throw new Error("old worker failed");
      }
    } as unknown as StorageService;

    const failure = await new PhotosService(prisma, albums, storage).complete("user-1", photo.id).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({ code: "PHOTO_STATE_CHANGED" });
    expect(photo.status).toBe("READY");
  });

  it("does not let direct completion of a failed upload exceed the daily limit", async () => {
    const photo = {
      id: "photo-failed",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "FAILED",
      tempObjectKey: "temp/family-1/photo-failed",
      album: { familyId: "family-1" },
      mediaAsset: null
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => photo,
        updateMany: async () => ({ count: 1 })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: {
          count: async () => 10,
          updateMany: async () => ({ count: 1 })
        }
      })
    } as unknown as PrismaService;
    const read = vi.fn(async () => ({ bytes: png, contentType: "image/png" }));
    const storage = { read } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.complete("user-1", photo.id).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "DAILY_PHOTO_LIMIT"
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an image above the decoded pixel limit with a stable code", async () => {
    const oversizedJpegHeader = Buffer.from([
      255, 216, 255, 192, 0, 17, 8, 27, 88, 39, 16, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0,
      255, 218, 0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 0, 0, 255, 217
    ]);
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    const prisma = {
      album: { findUnique: async () => photo.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({ ...photo }),
        updateMany: async () => ({ count: 1 }),
        update: async () => ({ ...photo, status: "FAILED" })
      }
    } as unknown as PrismaService;
    const storage = {
      read: async () => ({ bytes: oversizedJpegHeader, contentType: "image/jpeg" })
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.complete("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as BadRequestException).getResponse()).toMatchObject({
      code: "INVALID_IMAGE"
    });
  });

  it("keeps a failed temp cleanup recoverable on the next completion", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "READY",
      tempObjectKey: "temp/family-1/photo-1",
      failureReason: "TEMP_OBJECT_CLEANUP_PENDING",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: { id: "asset-1" }
    };
    const prisma = {
      album: { findUnique: async () => photo.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({ ...photo }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { ...photo };
        }
      }
    } as unknown as PrismaService;
    let deleteAttempts = 0;
    const storage = {
      delete: async () => {
        if (deleteAttempts++ === 0) throw new Error("STORAGE_UNAVAILABLE");
      }
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const firstFailure = await photos.complete("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );
    expect((firstFailure as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "PHOTO_CLEANUP_FAILED"
    });
    await expect(photos.complete("user-1", "photo-1")).resolves.toEqual({
      photoId: "photo-1",
      status: "READY"
    });
    expect(photo).toMatchObject({ tempObjectKey: null, failureReason: null });
  });

  it("does not process the same upload twice concurrently", async () => {
    const pending = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    let lookupCount = 0;
    const read = vi.fn(async () => ({ bytes: png, contentType: "image/png" }));
    const prisma = {
      album: { findUnique: async () => pending.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({
          ...pending,
          status: lookupCount++ === 0 ? "PENDING_UPLOAD" : "PROCESSING"
        }),
        updateMany: async () => ({ count: 0 }),
        update: async () => ({ ...pending, status: "PROCESSING" })
      }
    } as unknown as PrismaService;
    const storage = { read } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.complete("user-1", "photo-1")).rejects.toBeInstanceOf(ConflictException);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a supported MIME type when the decoded image format is unsupported", async () => {
    const photo = {
      id: "photo-svg",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-svg",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    const prisma = {
      album: { findUnique: async () => photo.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => photo,
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: { data: Record<string, unknown> }) => ({ ...photo, ...data })
      }
    } as unknown as PrismaService;
    const storage = {
      read: async () => ({
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
        contentType: "image/jpeg"
      })
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.complete("user-1", photo.id).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as BadRequestException).getResponse()).toMatchObject({
      code: "UNSUPPORTED_IMAGE_FORMAT"
    });
  });

  it("rechecks the daily limit when an upload becomes failed before it is claimed", async () => {
    const basePhoto = {
      id: "photo-raced",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      tempObjectKey: "temp/family-1/photo-raced",
      album: { familyId: "family-1" },
      mediaAsset: null
    };
    let lookupCount = 0;
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({
          ...basePhoto,
          status: lookupCount++ === 0 ? "PENDING_UPLOAD" : "FAILED"
        }),
        updateMany: async ({ where }: { where: { OR?: Array<{ status?: string | { in?: string[] } }> } }) => {
          const statuses = (where.OR ?? []).flatMap(({ status }) =>
            typeof status === "string" ? [status] : status?.in ?? []
          );
          return { count: statuses.includes("FAILED") ? 1 : 0 };
        },
        update: async () => ({ ...basePhoto, status: "FAILED" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: {
          count: async () => 10,
          updateMany: async () => ({ count: 1 })
        }
      })
    } as unknown as PrismaService;
    const read = vi.fn(async () => {
      throw new Error("SHOULD_NOT_READ");
    });
    const storage = { read } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.complete("user-1", basePhoto.id).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "DAILY_PHOTO_LIMIT"
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns the stable completion response when another request finishes first", async () => {
    const pending = {
      id: "photo-1",
      albumId: "album-1",
      uploadedById: "user-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      album: { id: "album-1", familyId: "family-1" },
      mediaAsset: null
    };
    const ready = {
      ...pending,
      status: "READY",
      tempObjectKey: null,
      mediaAsset: {
        originalKey: "assets/family-1/hash/original",
        displayKey: "assets/family-1/hash/display.webp",
        thumbnailKey: "assets/family-1/hash/thumbnail.webp"
      }
    };
    let lookupCount = 0;
    const prisma = {
      album: { findUnique: async () => pending.album },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => lookupCount++ === 0 ? pending : ready,
        updateMany: async () => ({ count: 0 })
      }
    } as unknown as PrismaService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, {} as StorageService);

    await expect(photos.complete("user-1", "photo-1")).resolves.toEqual({
      photoId: "photo-1",
      status: "READY"
    });
  });

  it("limits concurrent image processing to two photos", async () => {
    const pending = Array.from({ length: 3 }, () => {
      let reject!: (reason: Error) => void;
      const promise = new Promise<never>((_, rejectPromise) => { reject = rejectPromise; });
      return { promise, reject };
    });
    const read = vi.fn(() => pending[read.mock.calls.length - 1].promise);
    const photo = (id: string) => ({
      id,
      albumId: "album-1",
      albumDate: new Date("2026-08-01T00:00:00.000Z"),
      uploadedById: "user-1",
      tempObjectKey: `temp/${id}`,
      status: "PENDING_UPLOAD",
      album: { familyId: "family-1" },
      mediaAsset: null
    });
    const prisma = {
      photo: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => photo(where.id)),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => undefined)
      }
    } as unknown as PrismaService;
    const albums = { requireAlbum: vi.fn(async () => undefined) } as unknown as AlbumsService;
    const storage = { read } as unknown as StorageService;
    const photos = new PhotosService(prisma, albums, storage);

    const completions = ["photo-1", "photo-2", "photo-3"].map((id) => photos.complete("user-1", id));
    const settled = Promise.allSettled(completions);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    pending[0].reject(new Error("stop"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    pending[1].reject(new Error("stop"));
    pending[2].reject(new Error("stop"));
    await settled;
  });
});

describe("photo storage limits", () => {
  it("rejects the downloaded bytes when they exceed the upload limit", async () => {
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
    const body = {
      transformToByteArray: async () => oversized,
      async *[Symbol.asyncIterator]() {
        yield oversized;
      }
    };
    let requestCount = 0;
    const storage = Object.create(StorageService.prototype) as StorageService;
    Object.assign(storage, {
      config: { bucket: "test-bucket" },
      client: {
        send: async () =>
          requestCount++ === 0
            ? { ContentLength: 1, ContentType: "image/png" }
            : { Body: body }
      }
    });

    const failure = await storage.read("temp/family-1/photo-1").then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toMatchObject({ message: "FILE_TOO_LARGE" });
  });
});

describe("photo upload idempotency", () => {
  it("rejects an upload id already owned by another family member", async () => {
    const existing = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "other-user",
      originalName: "baby.jpg",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      capturedAt: null,
      dateSource: "USER",
      childTags: []
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "MEMBER" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: { findUnique: async () => existing }
      })
    } as unknown as PrismaService;
    const storage = {} as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "baby.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "1d3df46c-72dc-4d7b-9d51-3da82a4c61ce"
    }).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "UPLOAD_ID_CONFLICT"
    });
  });

  it("rejects an upload id reused for different photo metadata", async () => {
    const existing = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      originalName: "first.jpg",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      capturedAt: null,
      dateSource: "USER",
      childTags: []
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: { findUnique: async () => existing }
      })
    } as unknown as PrismaService;
    const storage = {} as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "second.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "1d3df46c-72dc-4d7b-9d51-3da82a4c61ce"
    }).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "UPLOAD_ID_CONFLICT"
    });
  });

  it("does not let a failed upload retry exceed the daily photo limit", async () => {
    const existing = {
      id: "photo-failed",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      originalName: "baby.jpg",
      status: "FAILED",
      tempObjectKey: "temp/family-1/photo-failed",
      capturedAt: null,
      dateSource: "USER",
      childTags: []
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: {
          findUnique: async () => existing,
          count: async () => 10
        }
      })
    } as unknown as PrismaService;
    const storage = {} as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "baby.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "1d3df46c-72dc-4d7b-9d51-3da82a4c61ce"
    }).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "DAILY_PHOTO_LIMIT"
    });
  });

  it("does not issue another PUT URL while an upload is processing", async () => {
    const existing = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      originalName: "baby.jpg",
      status: "PROCESSING",
      tempObjectKey: "temp/family-1/photo-1",
      capturedAt: null,
      dateSource: "USER",
      childTags: []
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: { findUnique: async () => existing }
      })
    } as unknown as PrismaService;
    const presignUpload = vi.fn(async () => "https://storage.example/upload");
    const storage = { presignUpload } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "baby.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "1d3df46c-72dc-4d7b-9d51-3da82a4c61ce"
    })).resolves.toMatchObject({ status: "PROCESSING", uploadUrl: null });
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it("lets the uploader retry an upload after abandoned-file cleanup", async () => {
    const existing = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      originalName: "baby.jpg",
      status: "DELETED",
      tempObjectKey: null,
      mediaAssetId: null,
      failureReason: "UPLOAD_EXPIRED",
      capturedAt: null,
      dateSource: "USER",
      childTags: []
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: {
          findUnique: async () => existing,
          count: async () => 0,
          update: async ({ data }: { data: Record<string, unknown> }) => ({
            ...existing,
            ...data,
            childTags: []
          })
        }
      })
    } as unknown as PrismaService;
    const storage = {
      presignUpload: vi.fn(async () => "https://storage.example/upload")
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "baby.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "1d3df46c-72dc-4d7b-9d51-3da82a4c61ce"
    })).resolves.toMatchObject({
      photoId: "photo-1",
      status: "PENDING_UPLOAD",
      uploadUrl: "https://storage.example/upload"
    });
  });

  it("retires an expired upload key before issuing a new upload", async () => {
    const stale = {
      id: "photo-stale",
      tempObjectKey: "temp/family-1/old-key",
      status: "PENDING_UPLOAD"
    };
    const created = {
      id: "photo-new",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      capturedAt: null,
      dateSource: "USER",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/new-key",
      childTags: []
    };
    let expiredStatus = "";
    const clearExpiredKey = vi.fn(async () => ({ ...stale, status: "DELETED", tempObjectKey: null }));
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { update: clearExpiredKey },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: {
          findUnique: async () => null,
          findMany: async () => [stale],
          updateMany: async ({ data }: { data: { status: string } }) => {
            expiredStatus = data.status;
            return { count: 1 };
          },
          count: async () => 0,
          create: async () => created
        }
      })
    } as unknown as PrismaService;
    const storage = {
      delete: vi.fn(async () => undefined),
      presignUpload: vi.fn(async () => "https://storage.example/upload")
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "new.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "4f37028b-a575-42c4-8b78-b67b2c41df3e"
    });

    expect(expiredStatus).toBe("DELETED");
    expect(storage.delete).toHaveBeenCalledWith(stale.tempObjectKey);
    expect(clearExpiredKey).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: stale.id },
      data: expect.objectContaining({ tempObjectKey: null, failureReason: "UPLOAD_EXPIRED" })
    }));
  });

  it("does not delete an expired candidate reclaimed by another completion", async () => {
    const stale = {
      id: "photo-reclaimed",
      tempObjectKey: "temp/family-1/reclaimed-key",
      status: "PROCESSING"
    };
    const created = {
      id: "photo-new",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      capturedAt: null,
      dateSource: "USER",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/new-key",
      childTags: []
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { update: vi.fn() },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        photo: {
          findUnique: async () => null,
          findMany: async () => [stale],
          updateMany: async () => ({ count: 0 }),
          count: async () => 1,
          create: async () => created
        }
      })
    } as unknown as PrismaService;
    const storage = {
      delete: vi.fn(async () => undefined),
      presignUpload: vi.fn(async () => "https://storage.example/upload")
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await photos.startUpload("user-1", "album-1", {
      date: "2026-08-03",
      originalName: "new.jpg",
      contentType: "image/jpeg",
      fileSize: 1024,
      clientUploadId: "93f556b0-9618-4ae9-961f-621a29124e3b"
    });

    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe("private photo URL authorization", () => {
  it("rejects an unknown image variant before querying storage", async () => {
    const findFirst = vi.fn();
    const presignDownload = vi.fn();
    const prisma = { photo: { findFirst } } as unknown as PrismaService;
    const storage = { presignDownload } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.url("user-1", "photo-1", "unknown" as "thumbnail")).rejects.toMatchObject({
      response: { code: "INVALID_PHOTO_VARIANT" }
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(presignDownload).not.toHaveBeenCalled();
  });

  it("authorizes a ready photo and its family membership in one lookup", async () => {
    const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const album = where.album as {
        family?: { members?: { some?: { userId?: string } } };
      };
      if (album.family?.members?.some?.userId !== "user-1") return null;
      return {
        originalName: "baby.jpg",
        mediaAsset: {
          originalKey: "assets/family-1/hash/original",
          displayKey: "assets/family-1/hash/display.webp",
          thumbnailKey: "assets/family-1/hash/thumbnail.webp"
        }
      };
    });
    const prisma = { photo: { findFirst } } as unknown as PrismaService;
    const storage = {
      presignDownload: async () => "https://storage.example/photo"
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.url("user-1", "photo-1", "thumbnail")).resolves.toEqual({
      url: "https://storage.example/photo"
    });
    await expect(photos.url("other-user", "photo-1", "thumbnail")).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});

describe("daily representative serialization", () => {
  it("checks readiness and writes the representative under the date lock", async () => {
    let locked = false;
    const representative = { id: "representative-1", photoId: "photo-1" };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => {
          locked = true;
        },
        photo: {
          findFirst: async () => locked ? { id: "photo-1" } : null
        },
        dailyRepresentative: {
          upsert: async () => {
            if (!locked) throw new Error("DATE_NOT_LOCKED");
            return representative;
          }
        }
      })
    } as unknown as PrismaService;
    const storage = {} as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(
      photos.setRepresentative("user-1", "album-1", "2026-08-03", "photo-1")
    ).resolves.toEqual(representative);
    expect(locked).toBe(true);
  });
});

describe("unfinished photo deletion", () => {
  it("deletes the stored asset when the removed photo is its last active reference", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "READY",
      tempObjectKey: null,
      mediaAssetId: "asset-1"
    };
    let transactionActive = false;
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      originalKey: "assets/family-1/hash/original",
      displayKey: "assets/family-1/hash/display.webp",
      thumbnailKey: "assets/family-1/hash/thumbnail.webp",
      status: "READY"
    };
    const deleteAsset = vi.fn(async () => ({ id: "asset-1" }));
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { findUnique: async () => ({ ...photo }) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        transactionActive = true;
        try {
          return await work({
            $executeRaw: async () => undefined,
            dailyRepresentative: {
              deleteMany: async () => ({ count: 0 }),
              create: async () => ({ id: "representative-1" })
            },
            photo: {
              count: async () => 0,
              updateMany: async () => ({ count: 1 }),
              findFirst: async () => null
            },
            mediaAsset: {
              findUnique: async () => asset,
              update: async ({ data }: { data: { status: "READY" | "ORPHANED" | "DELETING" } }) => {
                asset.status = data.status;
                return asset;
              },
              delete: deleteAsset
            }
          });
        } finally {
          transactionActive = false;
        }
      }
    } as unknown as PrismaService;
    const deleteObject = vi.fn(async () => {
      expect(transactionActive).toBe(false);
      expect(asset.status).toBe("DELETING");
    });
    const storage = { delete: deleteObject } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.remove("user-1", photo.id)).resolves.toEqual({ ok: true });
    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(deleteAsset).toHaveBeenCalled();
  });

  it("reports logical deletion as successful when storage cleanup is pending", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "READY",
      tempObjectKey: null,
      mediaAssetId: "asset-1"
    };
    const asset = {
      id: "asset-1",
      familyId: "family-1",
      sha256: "hash",
      originalKey: "assets/family-1/hash/original",
      displayKey: "assets/family-1/hash/display.webp",
      thumbnailKey: "assets/family-1/hash/thumbnail.webp",
      status: "READY"
    };
    const tx = {
      $executeRaw: async () => undefined,
      dailyRepresentative: {
        deleteMany: async () => ({ count: 0 }),
        create: async () => ({ id: "representative-1" })
      },
      photo: {
        count: async () => 0,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { count: 1 };
        },
        findFirst: async () => null
      },
      mediaAsset: {
        findUnique: async () => asset,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(asset, data);
          return asset;
        }
      }
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { findUnique: async () => ({ ...photo }) },
      mediaAsset: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(asset, data);
          return { count: 1 };
        }
      },
      $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx)
    } as unknown as PrismaService;
    const storage = {
      delete: async () => { throw new Error("storage unavailable"); }
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);

    await expect(new PhotosService(prisma, albums, storage).remove("user-1", photo.id))
      .resolves.toEqual({ ok: true, cleanupPending: true });
    expect(photo.status).toBe("DELETED");
    expect(asset.status).toBe("ORPHANED");
  });

  it("rejects deleting a photo while it is processing", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "PROCESSING",
      tempObjectKey: "temp/family-1/photo-1",
      failureReason: null
    };
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
      dailyRepresentative: {
        deleteMany: async () => ({ count: 0 }),
        create: async () => ({ id: "representative-1" })
      },
      photo: {
        update: async () => ({ ...photo, status: "DELETED" }),
        findFirst: async () => null
      }
    }));
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { findUnique: async () => ({ ...photo }) },
      $transaction: transaction
    } as unknown as PrismaService;
    const storage = { delete: async () => undefined } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.remove("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "PHOTO_PROCESSING"
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("preserves processing when the state changes before deletion commits", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      failureReason: null
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { findUnique: async () => ({ ...photo }) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        photo.status = "PROCESSING";
        return work({
          $executeRaw: async () => undefined,
          dailyRepresentative: {
            deleteMany: async () => ({ count: 0 }),
            create: async () => ({ id: "representative-1" })
          },
          photo: {
            update: async () => {
              photo.status = "DELETED";
              return { ...photo };
            },
            updateMany: async () => ({ count: 0 }),
            findFirst: async () => null
          }
        });
      }
    } as unknown as PrismaService;
    const deleteObject = vi.fn(async () => undefined);
    const storage = { delete: deleteObject } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    const failure = await photos.remove("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: "PHOTO_STATE_CHANGED"
    });
    expect(photo.status).toBe("PROCESSING");
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("does not replace the representative when deleting a different photo", async () => {
    const photo = {
      id: "photo-2",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "READY",
      tempObjectKey: null
    };
    const createRepresentative = vi.fn(async () => ({ id: "representative-2" }));
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: { findUnique: async () => ({ ...photo }) },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        dailyRepresentative: {
          deleteMany: async () => ({ count: 0 }),
          create: createRepresentative
        },
        photo: {
          updateMany: async () => ({ count: 1 }),
          findFirst: async () => ({ id: "photo-1" })
        }
      })
    } as unknown as PrismaService;
    const storage = {} as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.remove("user-1", "photo-2")).resolves.toEqual({ ok: true });
    expect(createRepresentative).not.toHaveBeenCalled();
  });

  it("keeps a failed temp deletion recoverable on the next request", async () => {
    const photo = {
      id: "photo-1",
      albumId: "album-1",
      albumDate: new Date("2026-08-03T00:00:00.000Z"),
      uploadedById: "user-1",
      status: "PENDING_UPLOAD",
      tempObjectKey: "temp/family-1/photo-1",
      failureReason: null as string | null
    };
    const updatePhoto = ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(photo, data);
      return { ...photo };
    };
    const prisma = {
      album: {
        findUnique: async () => ({ id: "album-1", familyId: "family-1", name: "우리의 여름" })
      },
      familyMember: {
        findUnique: async () => ({ familyId: "family-1", userId: "user-1", role: "OWNER" })
      },
      photo: {
        findUnique: async () => ({ ...photo }),
        update: async (args: { data: Record<string, unknown> }) => updatePhoto(args)
      },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        $executeRaw: async () => undefined,
        dailyRepresentative: {
          deleteMany: async () => ({ count: 0 }),
          create: async () => ({ id: "representative-1" })
        },
        photo: {
          update: async (args: { data: Record<string, unknown> }) => updatePhoto(args),
          updateMany: async (args: { data: Record<string, unknown> }) => {
            updatePhoto(args);
            return { count: 1 };
          },
          findFirst: async () => null
        }
      })
    } as unknown as PrismaService;
    let deleteAttempts = 0;
    const storage = {
      delete: async () => {
        if (deleteAttempts++ === 0) throw new Error("STORAGE_UNAVAILABLE");
      }
    } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.remove("user-1", "photo-1"))
      .resolves.toEqual({ ok: true, cleanupPending: true });
    await expect(photos.remove("user-1", "photo-1")).resolves.toEqual({ ok: true });
    expect(photo).toMatchObject({
      status: "DELETED",
      tempObjectKey: null,
      failureReason: null
    });
  });

  it("resumes abandoned upload cleanup when the photo service starts", async () => {
    const photo = {
      id: "photo-1",
      status: "FAILED",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null,
      updatedAt: new Date(0)
    };
    const prisma = {
      photo: {
        findMany: async () => [{ ...photo }],
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { ...photo };
        }
      }
    } as unknown as PrismaService;
    const storage = { delete: vi.fn(async () => undefined) } as unknown as StorageService;
    const service = new PhotosService(prisma, {} as AlbumsService, storage);

    service.onModuleInit();
    await vi.waitFor(() => {
      expect(storage.delete).toHaveBeenCalledWith("temp/family-1/photo-1");
      expect(photo).toMatchObject({
        status: "DELETED",
        tempObjectKey: null,
        failureReason: "UPLOAD_EXPIRED"
      });
    });
    service.onModuleDestroy();
  });

  it("retries a deleted photo's pending cleanup when the photo service starts", async () => {
    const photo = {
      id: "photo-1",
      status: "DELETED",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null,
      updatedAt: new Date()
    };
    const prisma = {
      photo: {
        findMany: async () => [{ ...photo }],
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { ...photo };
        }
      }
    } as unknown as PrismaService;
    const storage = { delete: vi.fn(async () => undefined) } as unknown as StorageService;
    const service = new PhotosService(prisma, {} as AlbumsService, storage);

    service.onModuleInit();
    await vi.waitFor(() => {
      expect(storage.delete).toHaveBeenCalledWith("temp/family-1/photo-1");
      expect(photo.tempObjectKey).toBeNull();
    });
    service.onModuleDestroy();
  });

  it("retries temp cleanup for a ready photo without deleting the photo", async () => {
    const photo = {
      id: "photo-1",
      status: "READY",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: "asset-1",
      failureReason: "TEMP_OBJECT_CLEANUP_PENDING",
      updatedAt: new Date()
    };
    const prisma = {
      photo: {
        findMany: async () => [{ ...photo }],
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(photo, data);
          return { ...photo };
        }
      }
    } as unknown as PrismaService;
    const storage = { delete: vi.fn(async () => undefined) } as unknown as StorageService;
    const service = new PhotosService(prisma, {} as AlbumsService, storage);

    service.onModuleInit();
    await vi.waitFor(() => {
      expect(photo).toMatchObject({
        status: "READY",
        tempObjectKey: null,
        failureReason: null
      });
    });
    service.onModuleDestroy();
  });

  it("moves a failed cleanup behind other queued photos", async () => {
    const updates: Record<string, unknown>[] = [];
    const photo = {
      id: "photo-1",
      status: "DELETED",
      tempObjectKey: "temp/family-1/photo-1",
      mediaAssetId: null,
      updatedAt: new Date(0)
    };
    const prisma = {
      photo: {
        findMany: async () => [{ ...photo }],
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { ...photo, ...data };
        }),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { count: 1 };
        })
      }
    } as unknown as PrismaService;
    const storage = {
      delete: vi.fn(async () => { throw new Error("storage unavailable"); })
    } as unknown as StorageService;
    const service = new PhotosService(prisma, {} as AlbumsService, storage);

    service.onModuleInit();
    await vi.waitFor(() => {
      expect(updates).toContainEqual({ failureReason: "PHOTO_CLEANUP_PENDING" });
    });
    service.onModuleDestroy();
  });

  it("does not block application startup while cleanup is waiting", async () => {
    let release!: (photos: never[]) => void;
    const waiting = new Promise<never[]>((resolve) => { release = resolve; });
    const service = new PhotosService({
      photo: { findMany: () => waiting }
    } as unknown as PrismaService, {} as AlbumsService, {} as StorageService);

    const initialization = service.onModuleInit();
    release([]);
    await Promise.resolve(initialization);
    service.onModuleDestroy();

    expect(initialization).toBeUndefined();
  });
});
