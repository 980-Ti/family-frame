import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadPhotoObject, uploadStartPayload } from "./upload-form";

describe("photo upload retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("bounds direct object-storage uploads", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const file = new File(["photo"], "baby.jpg", { type: "image/jpeg" });

    await uploadPhotoObject("https://storage.test/upload", file);

    expect(timeout).toHaveBeenCalledWith(300_000);
    expect(request.mock.calls[0]?.[1]?.signal).toBe(signal);
  });
});
