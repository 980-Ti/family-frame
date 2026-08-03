import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  canInteractWithPhoto,
  nextPresentedPhotoId,
  panZoom,
  photoSwipeDirection,
  PhotoGallery,
  zoomAtPoint
} from "./photo-gallery";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

describe("photo gallery empty state", () => {
  it("opens photo upload for the selected date", () => {
    const uploadHref = "/families/family-1/albums/album-1/upload?date=2026-07-02";
    const markup = renderToStaticMarkup(
      <PhotoGallery
        photos={[]}
        currentUserId="user-1"
        canDeleteAll={false}
        uploadHref={uploadHref}
      />
    );

    expect(markup).toContain(`href="${uploadHref}"`);
    expect(markup).toContain("첫 사진 추가하기");
  });

  it("server-renders the initial virtualized feed items", () => {
    const markup = renderToStaticMarkup(
      <PhotoGallery
        photos={[{
          id: "photo-1",
          albumDate: "2026-08-03",
          originalName: "첫 사진.jpg",
          uploadedById: "user-1",
          createdAt: "2026-08-03T00:00:00.000Z",
          mediaAsset: { width: 640, height: 640 },
          childTags: []
        }]}
        currentUserId="user-1"
        canDeleteAll
        uploadHref="/upload"
      />
    );

    expect(markup).toContain("첫 사진.jpg");
  });
});

describe("photo gallery zoom", () => {
  it("keeps the image point under the mouse pointer while zooming", () => {
    const pointer = { x: 240, y: 160 };
    const current = { scale: 1, x: 0, y: 0 };
    const next = zoomAtPoint(current, -1, pointer);

    expect(next.scale).toBe(1.25);
    expect((pointer.x - next.x) / next.scale).toBeCloseTo(pointer.x);
    expect((pointer.y - next.y) / next.scale).toBeCloseTo(pointer.y);
  });

  it("blocks actions while the selected photo is not the displayed photo", () => {
    expect(canInteractWithPhoto("photo-2", { photoId: "photo-1", status: "ready" })).toBe(false);
    expect(canInteractWithPhoto("photo-2", { photoId: "photo-2", status: "loading" })).toBe(false);
    expect(canInteractWithPhoto("photo-2", { photoId: "photo-2", status: "ready" })).toBe(true);
  });

  it("keeps the current metadata until the decoded image is ready", () => {
    expect(nextPresentedPhotoId("photo-1", "photo-2", "loading")).toBe("photo-1");
    expect(nextPresentedPhotoId("photo-1", "photo-2", "ready")).toBe("photo-2");
  });
});

describe("photo gallery touch navigation", () => {
  it("changes photos only for a clear horizontal swipe", () => {
    expect(photoSwipeDirection({ x: 200, y: 100 }, { x: 120, y: 105 })).toBe(1);
    expect(photoSwipeDirection({ x: 120, y: 100 }, { x: 200, y: 105 })).toBe(-1);
    expect(photoSwipeDirection({ x: 200, y: 100 }, { x: 180, y: 170 })).toBe(0);
  });

  it("keeps a zoomed photo inside the viewport while dragging", () => {
    expect(panZoom(
      { scale: 2, x: -100, y: -50 },
      { x: 500, y: -500 },
      { width: 300, height: 200 }
    )).toEqual({ scale: 2, x: 0, y: -200 });
  });
});
