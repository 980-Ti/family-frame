import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { StartUploadDto } from "../src/photos/photos.dto.js";

function uploadDto(contentType: string) {
  return Object.assign(new StartUploadDto(), {
    date: "2026-08-03",
    originalName: "baby.jpg",
    contentType,
    fileSize: 1024,
    clientUploadId: "4f37028b-a575-42c4-8b78-b67b2c41df3e"
  });
}

describe("StartUploadDto", () => {
  it("accepts formats supported by the image processor", async () => {
    await expect(validate(uploadDto("image/jpeg"))).resolves.toHaveLength(0);
  });

  it("rejects HEIC until the image processor supports it", async () => {
    const errors = await validate(uploadDto("image/heic"));
    expect(errors.some(({ property }) => property === "contentType")).toBe(true);
  });
});
