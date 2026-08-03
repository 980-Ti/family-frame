"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import { clientApi } from "@/lib/api";
import type { Photo, PhotoFeedPage } from "@/lib/types";
import { PhotoGallery } from "./photo-gallery";

export function appendUniquePhotos(current: Photo[], incoming: Photo[]): Photo[] {
  const knownIds = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !knownIds.has(id))];
}

export function PhotoFeed({
  initialPage,
  feedPath,
  currentUserId,
  canDeleteAll,
  uploadHref,
  emptyTitle
}: {
  initialPage: PhotoFeedPage;
  feedPath: string;
  currentUserId: string;
  canDeleteAll: boolean;
  uploadHref: string;
  emptyTitle: string;
}) {
  const [photos, setPhotos] = useState<Photo[]>(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const separator = feedPath.includes("?") ? "&" : "?";
      const page = await clientApi<PhotoFeedPage>(
        `${feedPath}${separator}cursor=${encodeURIComponent(nextCursor)}`
      );
      setPhotos((current) => appendUniquePhotos(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "사진을 더 불러오지 못했습니다.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [feedPath, nextCursor]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "600px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  return (
    <>
      <PhotoGallery
        photos={photos}
        currentUserId={currentUserId}
        canDeleteAll={canDeleteAll}
        uploadHref={uploadHref}
        emptyTitle={emptyTitle}
        emptyDescription="다른 필터를 선택하거나 새 사진을 추가해 보세요."
        showDate
      />
      {nextCursor ? (
        <div
          ref={sentinelRef}
          data-photo-feed-sentinel
          className="flex min-h-20 items-center justify-center"
          aria-live="polite"
        >
          {loading ? (
            <span className="muted inline-flex items-center gap-2 text-sm">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              사진 불러오는 중…
            </span>
          ) : error ? (
            <Button type="button" variant="outline" onClick={() => void loadMore()}>
              다시 시도
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="sr-only focus:not-sr-only"
              onClick={() => void loadMore()}
            >
              다음 사진 불러오기
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}
