import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Photo } from "@/lib/types";

vi.mock("./photo-gallery", () => ({
  PhotoGallery: () => <div data-testid="gallery" />
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
});
