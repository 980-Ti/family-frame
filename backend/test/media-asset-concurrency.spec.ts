import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlbumsService } from "../src/albums/albums.service.js";
import { PrismaService } from "../src/common/prisma.service.js";
import { MediaService } from "../src/media/media.service.js";
import { StorageService } from "../src/media/storage.service.js";

const { processMp4Mock } = vi.hoisted(() => ({ processMp4Mock: vi.fn() }));
vi.mock("../src/media/video-processor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/media/video-processor.js")>(),
  processMp4: processMp4Mock
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const PNG_SHA256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

type AssetStatus = "ORPHANED" | "UPLOADING" | "READY" | "DELETING";
type MediaStatus = "PENDING_UPLOAD" | "PROCESSING" | "READY" | "FAILED" | "DELETED";
type TestAsset = {
  id: string;
  familyId: string;
  sha256: string;
  deduplicationMode: "ENABLED" | "DISABLED";
  deduplicationKey: string;
  mimeType: string;
  width: number;
  height: number;
  originalKey: string;
  displayKey: string;
  thumbnailKey: string;
  status: AssetStatus;
  createdAt: Date;
  updatedAt: Date;
};
type TestMedia = {
  id: string;
  albumId: string;
  albumDate: Date;
  uploadedById: string;
  originalName: string;
  uploadContentType: string;
  uploadSize: number;
  tempObjectKey: string | null;
  mediaAssetId: string | null;
  status: MediaStatus;
  failureReason: string | null;
  updatedAt: Date;
  createdAt: Date;
  album: { id: string; familyId: string };
};

function mediaRecord(id: string, familyId = "family-1", contentType = "image/png"): TestMedia {
  return {
    id,
    albumId: `album-${familyId}`,
    albumDate: new Date("2026-08-03T00:00:00.000Z"),
    uploadedById: "user-1",
    originalName: contentType === "video/mp4" ? "baby.mp4" : "baby.png",
    uploadContentType: contentType,
    uploadSize: contentType === "video/mp4" ? 1024 : png.length,
    tempObjectKey: `temp/${familyId}/${id}`,
    mediaAssetId: null,
    status: "PENDING_UPLOAD",
    failureReason: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    album: { id: `album-${familyId}`, familyId }
  };
}

function assetRecord(status: AssetStatus, updatedAt: Date, familyId = "family-1"): TestAsset {
  return {
    id: `asset-${familyId}`,
    familyId,
    sha256: PNG_SHA256,
    deduplicationMode: "ENABLED",
    deduplicationKey: `enabled:${familyId}:${PNG_SHA256}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    originalKey: `assets/${familyId}/hash/original`,
    displayKey: `assets/${familyId}/hash/display.webp`,
    thumbnailKey: `assets/${familyId}/hash/thumbnail.webp`,
    status,
    createdAt: new Date(0),
    updatedAt
  };
}

function createHarness(initialMedia: TestMedia[], initialAssets: TestAsset[] = []) {
  const media = initialMedia;
  const assets = initialAssets;
  const assetTransitions: AssetStatus[] = [];
  const lockKeys: string[] = [];
  const put = vi.fn(async () => undefined);
  const copy = vi.fn(async () => undefined);
  const removeObject = vi.fn(async () => undefined);
  const storage = {
    read: vi.fn(async () => ({ bytes: png, contentType: "image/png" })),
    readVideo: vi.fn(async () => ({
      path: "input.mp4",
      sha256: "video-hash",
      contentType: "video/mp4" as const,
      cleanup: async () => undefined
    })),
    put,
    copy,
    delete: removeObject
  };

  const findAsset = (where: { id?: string; deduplicationKey?: string }) =>
    assets.find((asset) => asset.id === where.id || asset.deduplicationKey === where.deduplicationKey) ?? null;
  const matchesDate = (actual: Date, expected?: Date | { lt: Date }) => {
    if (!expected) return true;
    return expected instanceof Date ? actual.getTime() === expected.getTime() : actual < expected.lt;
  };
  const assetApi = {
    upsert: async ({ where, create }: { where: { deduplicationKey: string }; create: Omit<TestAsset, "id" | "createdAt" | "updatedAt"> }) => {
      const existing = findAsset(where);
      if (existing) return existing;
      const now = new Date();
      const created = { id: `asset-${assets.length + 1}`, ...create, createdAt: now, updatedAt: now } as TestAsset;
      assets.push(created);
      return created;
    },
    findUnique: async ({ where }: { where: { id?: string; deduplicationKey?: string } }) => findAsset(where),
    updateMany: async ({ where, data }: {
      where: { id: string; status?: AssetStatus; updatedAt?: Date | { lt: Date } };
      data: { status?: AssetStatus; updatedAt?: Date };
    }) => {
      const asset = findAsset({ id: where.id });
      if (!asset || (where.status && asset.status !== where.status) || !matchesDate(asset.updatedAt, where.updatedAt)) {
        return { count: 0 };
      }
      if (data.status) {
        asset.status = data.status;
        assetTransitions.push(data.status);
      }
      asset.updatedAt = data.updatedAt ?? new Date();
      return { count: 1 };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = assets.findIndex((asset) => asset.id === where.id);
      if (index >= 0) assets.splice(index, 1);
      return null;
    }
  };
  const matchesMediaStatus = (actual: MediaStatus, expected?: MediaStatus | { in: MediaStatus[] }) =>
    !expected || (typeof expected === "string" ? actual === expected : expected.in.includes(actual));
  const mediaApi = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const item = media.find((candidate) => candidate.id === where.id);
      if (!item) return null;
      return { ...item, mediaAsset: item.mediaAssetId ? findAsset({ id: item.mediaAssetId }) : null };
    },
    updateMany: async ({ where, data }: {
      where: { id: string; status?: MediaStatus | { in: MediaStatus[] }; updatedAt?: Date | { lt: Date } };
      data: Partial<TestMedia>;
    }) => {
      const item = media.find((candidate) => candidate.id === where.id);
      if (!item || !matchesMediaStatus(item.status, where.status) || !matchesDate(item.updatedAt, where.updatedAt)) {
        return { count: 0 };
      }
      Object.assign(item, data);
      if (!data.updatedAt) item.updatedAt = new Date();
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<TestMedia> }) => {
      const item = media.find((candidate) => candidate.id === where.id);
      if (!item) throw new Error("MEDIA_NOT_FOUND");
      Object.assign(item, data);
      return { ...item, mediaAsset: item.mediaAssetId ? findAsset({ id: item.mediaAssetId }) : null };
    },
    count: async ({ where }: { where: { mediaAssetId?: string; status?: { not: MediaStatus } } }) =>
      media.filter((item) =>
        (!where.mediaAssetId || item.mediaAssetId === where.mediaAssetId)
        && (!where.status?.not || item.status !== where.status.not)
      ).length,
    findFirst: async () => null
  };
  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, key: string) => { lockKeys.push(key); },
    mediaAsset: assetApi,
    media: mediaApi,
    dailyRepresentative: {
      upsert: async () => ({ id: "representative-1" }),
      deleteMany: async () => ({ count: 0 }),
      create: async () => ({ id: "representative-1" })
    }
  };
  const prisma = {
    media: mediaApi,
    mediaAsset: assetApi,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
      const mediaSnapshot = media.map((item) => ({ ...item }));
      const assetSnapshot = assets.map((asset) => ({ ...asset }));
      try {
        return await work(tx);
      } catch (error) {
        for (const snapshot of mediaSnapshot) {
          const current = media.find((item) => item.id === snapshot.id);
          if (current) Object.assign(current, snapshot);
        }
        for (let index = assets.length - 1; index >= 0; index -= 1) {
          if (!assetSnapshot.some((snapshot) => snapshot.id === assets[index].id)) assets.splice(index, 1);
        }
        for (const snapshot of assetSnapshot) {
          const current = assets.find((asset) => asset.id === snapshot.id);
          if (current) Object.assign(current, snapshot);
        }
        throw error;
      }
    }
  } as unknown as PrismaService;
  const albums = {
    requireAlbum: async () => ({ album: media[0]?.album, membership: { role: "OWNER" } })
  } as unknown as AlbumsService;
  const service = new MediaService(prisma, albums, storage as unknown as StorageService);
  return { service, media, assets, assetTransitions, lockKeys, storage, put, copy, removeObject };
}

describe("media asset claim ownership", () => {
  beforeEach(() => {
    process.env.MEDIA_DEDUPLICATION_ENABLED = "true";
    processMp4Mock.mockReset();
    processMp4Mock.mockResolvedValue({
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      thumbnail: Buffer.from("thumbnail")
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MEDIA_DEDUPLICATION_ENABLED;
  });

  it("times out without stealing or mutating a recent upload claim", async () => {
    vi.useFakeTimers();
    const item = mediaRecord("media-waiter", "family-1", "video/mp4");
    const asset = assetRecord("UPLOADING", new Date());
    asset.sha256 = "video-hash";
    asset.deduplicationKey = "enabled:family-1:video-hash";
    const harness = createHarness([item], [asset]);

    const completion = harness.service.complete("user-1", item.id).then(
      () => null,
      (error: unknown) => error
    );
    await Promise.resolve();
    await vi.runAllTimersAsync();
    const failure = await completion;

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toMatchObject({
      code: "MEDIA_ASSET_UPLOAD_TIMEOUT"
    });
    expect(item.status).toBe("FAILED");
    expect(asset.status).toBe("UPLOADING");
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.assetTransitions).not.toContain("ORPHANED");
  });

  it("reclaims a stale upload and records only the current claim transitions", async () => {
    const item = mediaRecord("media-recovery");
    const asset = assetRecord("UPLOADING", new Date(Date.now() - 16 * 60_000));
    const harness = createHarness([item], [asset]);

    await expect(harness.service.complete("user-1", item.id)).resolves.toEqual({
      mediaId: item.id,
      status: "READY"
    });
    expect(harness.put).toHaveBeenCalledTimes(3);
    expect(asset.status).toBe("READY");
    expect(harness.assetTransitions).toEqual(["UPLOADING", "READY"]);
  });

  it("recovers only the owned failed claim and allows the next retry", async () => {
    const item = mediaRecord("media-retry");
    const harness = createHarness([item]);
    harness.put.mockRejectedValueOnce(new Error("RGW_WRITE_FAILED"));

    await expect(harness.service.complete("user-1", item.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(item.status).toBe("FAILED");
    expect(harness.assets[0]).toMatchObject({ status: "ORPHANED" });

    harness.put.mockResolvedValue(undefined);
    await expect(harness.service.complete("user-1", item.id)).resolves.toEqual({ mediaId: item.id, status: "READY" });
    expect(harness.assets).toHaveLength(1);
    expect(harness.assets[0].status).toBe("READY");
  });

  it("recovers the owned claim when the media changes before READY commit", async () => {
    const item = mediaRecord("media-state-change");
    const harness = createHarness([item]);
    harness.put.mockImplementation(async () => {
      item.status = "DELETED";
    });

    await expect(harness.service.complete("user-1", item.id)).rejects.toMatchObject({
      response: { code: "MEDIA_STATE_CHANGED" }
    });
    expect(item.status).toBe("DELETED");
    expect(harness.assets[0].status).toBe("ORPHANED");
  });

  it.each(["true", "false"])("keeps a completed media idempotent when deduplication=%s", async (enabled) => {
    process.env.MEDIA_DEDUPLICATION_ENABLED = enabled;
    const item = mediaRecord(`media-${enabled}`);
    const harness = createHarness([item]);

    await harness.service.complete("user-1", item.id);
    const writes = harness.put.mock.calls.length;
    await expect(harness.service.complete("user-1", item.id)).resolves.toEqual({ mediaId: item.id, status: "READY" });
    expect(harness.assets).toHaveLength(1);
    expect(harness.put).toHaveBeenCalledTimes(writes);
  });

  it("does not share an enabled asset across families", async () => {
    const first = mediaRecord("media-family-1", "family-1");
    const second = mediaRecord("media-family-2", "family-2");
    const harness = createHarness([first, second]);

    await harness.service.complete("user-1", first.id);
    await harness.service.complete("user-1", second.id);
    expect(harness.assets).toHaveLength(2);
    expect(harness.put).toHaveBeenCalledTimes(6);
    expect(harness.assets[0].familyId).not.toBe(harness.assets[1].familyId);
  });

  it.each([
    ["true", 1, 1, 1],
    ["false", 2, 2, 2]
  ] as const)("preserves video processing when deduplication=%s", async (enabled, assetCount, copies, thumbnails) => {
    process.env.MEDIA_DEDUPLICATION_ENABLED = enabled;
    const first = mediaRecord("video-1", "family-1", "video/mp4");
    const second = mediaRecord("video-2", "family-1", "video/mp4");
    const harness = createHarness([first, second]);

    await harness.service.complete("user-1", first.id);
    await harness.service.complete("user-1", second.id);
    expect(harness.assets).toHaveLength(assetCount);
    expect(harness.copy).toHaveBeenCalledTimes(copies);
    expect(harness.put).toHaveBeenCalledTimes(thumbnails);
    if (!JSON.parse(enabled)) expect(harness.assets[0].originalKey).not.toBe(harness.assets[1].originalKey);
  });

  it("lets a concurrent enabled video waiter reuse the owner's upload", async () => {
    const first = mediaRecord("video-race-1", "family-1", "video/mp4");
    const second = mediaRecord("video-race-2", "family-1", "video/mp4");
    const harness = createHarness([first, second]);
    let signalCopyStarted!: () => void;
    const copyStarted = new Promise<void>((resolve) => { signalCopyStarted = resolve; });
    let releaseCopy!: () => void;
    const copyGate = new Promise<void>((resolve) => { releaseCopy = resolve; });
    harness.copy.mockImplementation(async () => {
      signalCopyStarted();
      await copyGate;
    });

    const owner = harness.service.complete("user-1", first.id);
    await copyStarted;
    const waiter = harness.service.complete("user-1", second.id);
    await vi.waitFor(() => expect(second.mediaAssetId).toBe("asset-1"));
    expect(harness.copy).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
    releaseCopy();

    await expect(Promise.all([owner, waiter])).resolves.toEqual([
      { mediaId: first.id, status: "READY" },
      { mediaId: second.id, status: "READY" }
    ]);
    expect(harness.assets).toHaveLength(1);
    expect(harness.copy).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed waiter perform the owner's ORPHANED recovery", async () => {
    const ownerMedia = mediaRecord("media-owner");
    const waiterMedia = mediaRecord("media-waiter");
    const harness = createHarness([ownerMedia, waiterMedia]);
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    let rejectWrites!: (error: Error) => void;
    const writeGate = new Promise<void>((_resolve, reject) => { rejectWrites = reject; });
    harness.put.mockImplementation(async () => {
      signalWriteStarted();
      await writeGate;
    });

    const owner = harness.service.complete("user-1", ownerMedia.id).catch((error: unknown) => error);
    await writeStarted;
    const waiter = harness.service.complete("user-1", waiterMedia.id).catch((error: unknown) => error);
    await vi.waitFor(() => expect(waiterMedia.mediaAssetId).toBe("asset-1"));
    rejectWrites(new Error("RGW_WRITE_FAILED"));
    const [ownerFailure, waiterFailure] = await Promise.all([owner, waiter]);

    expect(ownerFailure).toBeInstanceOf(ServiceUnavailableException);
    expect(waiterFailure).toBeInstanceOf(ServiceUnavailableException);
    expect(harness.assets[0].status).toBe("ORPHANED");
    expect(harness.assetTransitions.filter((status) => status === "ORPHANED")).toHaveLength(1);
    expect(harness.put).toHaveBeenCalledTimes(3);
  });
});

describe("media asset cleanup ownership", () => {
  beforeEach(() => { process.env.MEDIA_DEDUPLICATION_ENABLED = "true"; });
  afterEach(() => { delete process.env.MEDIA_DEDUPLICATION_ENABLED; });

  it("protects a recent upload even when its only media is deleted", async () => {
    const item = mediaRecord("media-uploading");
    const asset = assetRecord("UPLOADING", new Date());
    item.status = "READY";
    item.tempObjectKey = null;
    item.mediaAssetId = asset.id;
    const harness = createHarness([item], [asset]);

    await expect(harness.service.remove("user-1", item.id)).resolves.toEqual({ ok: true });
    expect(asset.status).toBe("UPLOADING");
    expect(harness.removeObject).not.toHaveBeenCalled();
  });

  it("cleans a stale unreferenced upload without deleting duplicate video keys twice", async () => {
    const item = mediaRecord("media-stale");
    const asset = assetRecord("UPLOADING", new Date(Date.now() - 16 * 60_000));
    asset.displayKey = asset.originalKey;
    item.status = "READY";
    item.tempObjectKey = null;
    item.mediaAssetId = asset.id;
    const harness = createHarness([item], [asset]);

    await expect(harness.service.remove("user-1", item.id)).resolves.toEqual({ ok: true });
    expect(harness.assets).toHaveLength(0);
    expect(harness.removeObject).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared asset until its last active media is deleted", async () => {
    const first = mediaRecord("media-shared-1");
    const second = mediaRecord("media-shared-2");
    const asset = assetRecord("READY", new Date());
    for (const item of [first, second]) {
      item.status = "READY";
      item.tempObjectKey = null;
      item.mediaAssetId = asset.id;
    }
    const harness = createHarness([first, second], [asset]);

    await harness.service.remove("user-1", first.id);
    expect(harness.assets).toHaveLength(1);
    expect(harness.removeObject).not.toHaveBeenCalled();
    await harness.service.remove("user-1", second.id);
    expect(harness.assets).toHaveLength(0);
    expect(harness.removeObject).toHaveBeenCalledTimes(3);
  });

  it("uses the same asset lock namespace for reserve, commit, recovery, cleanup, and delete", async () => {
    const item = mediaRecord("media-locks");
    const harness = createHarness([item]);
    await harness.service.complete("user-1", item.id);
    await harness.service.remove("user-1", item.id);

    const assetLocks = harness.lockKeys.filter((key) => key.startsWith("asset:"));
    expect(assetLocks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(assetLocks)).toEqual(new Set([`asset:enabled:family-1:${PNG_SHA256}`]));
  });
});
