import { describe, expect, it } from "vitest";
import { uploadStartPayload } from "./upload-form";

describe("photo upload retry", () => {
  it("reuses the selected photo id as the upload id", () => {
    const photo = {
      id: "1d3df46c-72dc-4d7b-9d51-3da82a4c61ce",
      file: { name: "baby.jpg", type: "image/jpeg", size: 1_024 } as File,
      albumDate: "2026-08-03",
      capturedAt: null,
      dateSource: "USER" as const,
      childTagIds: ["tag-1"],
      previewUrl: "blob:preview",
      status: "ready" as const
    };

    const first = uploadStartPayload(photo);
    const retry = uploadStartPayload(photo);

    expect(first.clientUploadId).toBe(photo.id);
    expect(first.fileSize).toBe(1_024);
    expect(first.childTagIds).toEqual(["tag-1"]);
    expect(retry).toEqual(first);
  });
});
