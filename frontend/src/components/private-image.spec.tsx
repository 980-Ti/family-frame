import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientApiMock } = vi.hoisted(() => ({ clientApiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ clientApi: clientApiMock }));

import {
  clearPrivateImageUrlCache,
  getPrivateImageUrl,
  MAX_SIGNED_URL_CACHE_ENTRIES,
  PrivateImage,
  shouldRequestPrivateImage
} from "./private-image";

describe("private image requests", () => {
  beforeEach(() => {
    clearPrivateImageUrlCache();
    clientApiMock.mockReset();
  });

  it("does not request an off-screen thumbnail but loads a display image immediately", () => {
    expect(shouldRequestPrivateImage("thumbnail", "photo-2:thumbnail", "photo-1:thumbnail")).toBe(false);
    expect(shouldRequestPrivateImage("display", null, "photo-1:display")).toBe(true);
  });

  it("reuses a fresh signed URL instead of requesting it on every render", async () => {
    clientApiMock.mockResolvedValue({ url: "https://storage.test/photo-1" });

    await getPrivateImageUrl("photo-1", "thumbnail");
    await getPrivateImageUrl("photo-1", "thumbnail");

    expect(clientApiMock).toHaveBeenCalledOnce();
  });

  it("forwards cancellation and can invalidate an expired image URL", async () => {
    const controller = new AbortController();
    clientApiMock
      .mockResolvedValueOnce({ url: "https://storage.test/expired" })
      .mockResolvedValueOnce({ url: "https://storage.test/fresh" });

    await getPrivateImageUrl("photo-1", "thumbnail", controller.signal);
    clearPrivateImageUrlCache("photo-1", "thumbnail");
    await expect(getPrivateImageUrl("photo-1", "thumbnail", controller.signal))
      .resolves.toBe("https://storage.test/fresh");

    expect(clientApiMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(clientApiMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the signed URL cache for long photo feeds", async () => {
    clientApiMock.mockImplementation(async (path: string) => ({ url: `https://storage.test${path}` }));

    for (let index = 0; index <= MAX_SIGNED_URL_CACHE_ENTRIES; index += 1) {
      await getPrivateImageUrl(`photo-${index}`, "thumbnail");
    }
    await getPrivateImageUrl("photo-0", "thumbnail");

    expect(clientApiMock).toHaveBeenCalledTimes(MAX_SIGNED_URL_CACHE_ENTRIES + 2);
  });

  it("keeps hooks stable for both image variants", () => {
    expect(() => renderToStaticMarkup(
      <>
        <PrivateImage photoId="photo-1" variant="thumbnail" alt="썸네일" />
        <PrivateImage photoId="photo-1" variant="display" alt="확대 사진" />
      </>
    )).not.toThrow();
  });
});
