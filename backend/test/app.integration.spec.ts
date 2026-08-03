import "reflect-metadata";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { PrismaService } from "../src/common/prisma.service.js";
import { StorageService } from "../src/photos/storage.service.js";

const integration = process.env.RUN_INTEGRATION === "1";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNQ6n4GAAJmAZTWXMniAAAAAElFTkSuQmCC",
  "base64"
);

describe.runIf(integration)("real PostgreSQL and S3 application boundary", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let familyId: string | undefined;
  let userId: string | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    if (familyId && prisma && storage) {
      const assets = await prisma.mediaAsset.findMany({
        where: { familyId },
        select: { originalKey: true, displayKey: true, thumbnailKey: true }
      });
      await Promise.allSettled(
        assets.flatMap((asset) => [
          storage.delete(asset.originalKey),
          storage.delete(asset.displayKey),
          storage.delete(asset.thumbnailKey)
        ])
      );
      await prisma.family.deleteMany({ where: { id: familyId } });
    }
    if (userId && prisma) await prisma.user.deleteMany({ where: { id: userId } });
    if (app) await app.close();
  });

  it("migrates, authenticates, uploads, transforms, lists, and downloads a private photo", async () => {
    await request(app.getHttpServer()).get("/api/health/ready").expect(200);

    const signup = await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email: `integration+${randomUUID()}@example.com`,
        password: "integration-password",
        displayName: "통합 테스트"
      })
      .expect(201);
    userId = signup.body.user.id as string;
    const sessionCookie = signup.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(sessionCookie).toBeTruthy();
    if (!sessionCookie) throw new Error("signup did not set a session cookie");

    const family = await request(app.getHttpServer())
      .post("/api/families")
      .set("Cookie", sessionCookie)
      .send({ name: "통합 테스트 가족" })
      .expect(201);
    familyId = family.body.id as string;

    const album = await request(app.getHttpServer())
      .post(`/api/families/${familyId}/albums`)
      .set("Cookie", sessionCookie)
      .send({ name: "통합 테스트 앨범", childNames: ["아이"] })
      .expect(201);
    const albumId = album.body.id as string;
    const childTagId = album.body.childTags[0].id as string;

    const start = await request(app.getHttpServer())
      .post(`/api/albums/${albumId}/uploads`)
      .set("Cookie", sessionCookie)
      .send({
        date: "2026-08-02",
        originalName: "pixel.png",
        contentType: "image/png",
        fileSize: onePixelPng.length,
        clientUploadId: randomUUID(),
        childTagIds: [childTagId]
      })
      .expect(201);

    const upload = await fetch(start.body.uploadUrl as string, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: onePixelPng
    });
    expect(upload.ok).toBe(true);

    const completed = await request(app.getHttpServer())
      .post(`/api/photos/${start.body.photoId}/complete`)
      .set("Cookie", sessionCookie);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    expect(completed.body.status).toBe("READY");

    const photos = await request(app.getHttpServer())
      .get(`/api/albums/${albumId}/photos?date=2026-08-02`)
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(photos.body).toHaveLength(1);
    expect(photos.body[0].id).toBe(start.body.photoId);

    const signed = await request(app.getHttpServer())
      .get(`/api/photos/${start.body.photoId}/url?variant=thumbnail`)
      .set("Cookie", sessionCookie)
      .expect(200);
    const thumbnail = await fetch(signed.body.url as string);
    expect(thumbnail.ok).toBe(true);
    expect(thumbnail.headers.get("content-type")).toContain("image/webp");
    expect((await thumbnail.arrayBuffer()).byteLength).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .delete(`/api/albums/${albumId}/child-tags/${childTagId}`)
      .set("Cookie", sessionCookie)
      .expect(204);

    const photosAfterTagDelete = await request(app.getHttpServer())
      .get(`/api/albums/${albumId}/photos?date=2026-08-02`)
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(photosAfterTagDelete.body).toHaveLength(1);
    expect(photosAfterTagDelete.body[0]).toMatchObject({
      id: start.body.photoId,
      childTags: []
    });

    const signedAfterTagDelete = await request(app.getHttpServer())
      .get(`/api/photos/${start.body.photoId}/url?variant=thumbnail`)
      .set("Cookie", sessionCookie)
      .expect(200);
    expect((await fetch(signedAfterTagDelete.body.url as string)).ok).toBe(true);
  }, 30_000);
});
