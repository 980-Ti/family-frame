// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Photo } from "@/lib/types";

const clientApiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ clientApi: clientApiMock }));

vi.mock("./photo-gallery", () => ({
  PhotoGallery: ({
    photos,
    onPhotoRemoved
  }: {
    photos: Photo[];
    onPhotoRemoved?: (photoId: string) => void;
  }) => (
    <div data-testid="gallery">
      <span data-photo-ids>{photos.map(({ id }) => id).join(",")}</span>
      <button type="button" onClick={() => onPhotoRemoved?.("old")}>delete</button>
    </div>
  )
}));

import { appendUniquePhotos, PhotoFeed } from "./photo-feed";

function photo(id: string): Photo {
  return {
    id,
    albumDate: "2026-08-03",
    originalName: `${id}.jpg`,
    uploadedById: "user-1",
    createdAt: "2026-08-03T00:00:00.000Z",
    mediaAsset: { width: 640, height: 640 },
    childTags: []
  };
}

describe("PhotoFeed", () => {
  it("appends cursor pages without retaining duplicate photos", () => {
    expect(appendUniquePhotos([photo("1"), photo("2")], [photo("2"), photo("3")]).map(({ id }) => id))
      .toEqual(["1", "2", "3"]);
  });

  it("renders an automatic loading sentinel instead of a load-more button", () => {
    const markup = renderToStaticMarkup(
      <PhotoFeed
        initialPage={{ items: [photo("1")], nextCursor: "next" }}
        feedPath="/albums/album-1/photo-feed?take=40"
        currentUserId="user-1"
        canDeleteAll
        uploadHref="/upload"
        emptyTitle="사진이 없습니다"
      />
    );

    expect(markup).toContain("data-photo-feed-sentinel");
    expect(markup).not.toContain("사진 더 보기");
  });

  it("refills the first page after deleting the last loaded cursor photo", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    clientApiMock.mockResolvedValueOnce({ items: [photo("older")], nextCursor: null });
    const container = document.createElement("div");
    const root = createRoot(container);
    const props = {
      feedPath: "/albums/album-1/photo-feed?take=40",
      currentUserId: "user-1",
      canDeleteAll: true,
      uploadHref: "/upload",
      emptyTitle: "사진이 없습니다"
    };

    await act(async () => root.render(
      <PhotoFeed initialPage={{ items: [photo("old")], nextCursor: "old" }} {...props} />
    ));
    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(clientApiMock).toHaveBeenCalledWith(props.feedPath);
    expect(container.querySelector("[data-photo-ids]")?.textContent).toBe("older");
    expect(container.querySelector("[data-photo-feed-sentinel]")).toBeNull();
    act(() => root.unmount());
  });
});
