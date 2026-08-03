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
    await expect(photos.complete("user-1", "photo-1")).resolves.toMatchObject({
      status: "READY",
      tempObjectKey: null
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
    await expect(photos.complete("user-1", "photo-1")).resolves.toMatchObject({
      status: "READY",
      tempObjectKey: null,
      failureReason: null
    });
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
    const deleteAsset = vi.fn(async () => ({ id: "asset-1" }));
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
          create: async () => ({ id: "representative-1" })
        },
        photo: {
          count: async () => 0,
          updateMany: async () => ({ count: 1 }),
          findFirst: async () => null
        },
        mediaAsset: {
          findUnique: async () => ({
            id: "asset-1",
            familyId: "family-1",
            sha256: "hash",
            originalKey: "assets/family-1/hash/original",
            displayKey: "assets/family-1/hash/display.webp",
            thumbnailKey: "assets/family-1/hash/thumbnail.webp"
          }),
          delete: deleteAsset
        }
      })
    } as unknown as PrismaService;
    const deleteObject = vi.fn(async () => undefined);
    const storage = { delete: deleteObject } as unknown as StorageService;
    const families = new FamiliesService(prisma);
    const albums = new AlbumsService(prisma, families);
    const photos = new PhotosService(prisma, albums, storage);

    await expect(photos.remove("user-1", photo.id)).resolves.toEqual({ ok: true });
    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(deleteAsset).toHaveBeenCalled();
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

    const firstFailure = await photos.remove("user-1", "photo-1").then(
      () => null,
      (error: unknown) => error
    );
    expect((firstFailure as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "PHOTO_CLEANUP_FAILED"
    });
    await expect(photos.remove("user-1", "photo-1")).resolves.toEqual({ ok: true });
    expect(photo).toMatchObject({
      status: "DELETED",
      tempObjectKey: null,
      failureReason: null
    });
  });
});
