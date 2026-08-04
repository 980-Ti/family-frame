import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { StorageService } from "../src/media/storage.service.js";

describe("video storage", () => {
  it("streams a video to disk while calculating its hash", async () => {
    const bytes = Buffer.from("video-in-two-chunks");
    const send = vi.fn(async (command: object) => {
      if (command.constructor.name === "HeadObjectCommand") {
        return { ContentType: "video/mp4", ContentLength: bytes.length };
      }
      return {
        Body: (async function* () {
          yield bytes.subarray(0, 5);
          yield bytes.subarray(5);
        })()
      };
    });
    const storage = Object.create(StorageService.prototype) as StorageService;
    Object.defineProperty(storage, "config", { value: { bucket: "test-bucket" } });
    Object.defineProperty(storage, "client", { value: { send } });

    const video = await storage.readVideo("temp/video");
    expect(await readFile(video.path)).toEqual(bytes);
    expect(video.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    await video.cleanup();
    await expect(access(video.path)).rejects.toThrow();
  });
});
