"use client";

import { useCallback, useRef, useState, type KeyboardEvent, type TouchEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ImagePlus, Minus, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { VirtuosoGrid } from "react-virtuoso";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { clientApi } from "@/lib/api";
import type { Photo } from "@/lib/types";
import { PrivateImage } from "./private-image";

type ZoomTransform = { scale: number; x: number; y: number };

const INITIAL_ZOOM: ZoomTransform = { scale: 1, x: 0, y: 0 };
type ImageLoadState = { photoId: string; status: "loading" | "ready" | "error" };

export function canInteractWithPhoto(selectedId: string, image: ImageLoadState): boolean {
  return image.photoId === selectedId && image.status === "ready";
}

export function nextPresentedPhotoId(
  currentId: string | null,
  requestedId: string,
  status: ImageLoadState["status"]
) {
  return status === "ready" ? requestedId : currentId;
}

export function zoomAtPoint(
  current: ZoomTransform,
  deltaY: number,
  point: { x: number; y: number }
): ZoomTransform {
  const scale = Math.min(4, Math.max(1, current.scale + (deltaY < 0 ? 0.25 : -0.25)));
  if (scale === current.scale) return current;
  if (scale === 1) return { ...INITIAL_ZOOM };
  const ratio = scale / current.scale;
  return {
    scale,
    x: point.x - (point.x - current.x) * ratio,
    y: point.y - (point.y - current.y) * ratio
  };
}

export function photoSwipeDirection(
  start: { x: number; y: number },
  end: { x: number; y: number }
): -1 | 0 | 1 {
  const x = end.x - start.x;
  const y = end.y - start.y;
  if (Math.abs(x) < 50 || Math.abs(x) <= Math.abs(y) * 1.2) return 0;
  return x > 0 ? -1 : 1;
}

export function panZoom(
  current: ZoomTransform,
  delta: { x: number; y: number },
  viewport: { width: number; height: number }
): ZoomTransform {
  if (current.scale <= 1) return current;
  return {
    ...current,
    x: Math.min(0, Math.max(viewport.width * (1 - current.scale), current.x + delta.x)),
    y: Math.min(0, Math.max(viewport.height * (1 - current.scale), current.y + delta.y))
  };
}

export function PhotoGallery({
  photos,
  currentUserId,
  canDeleteAll,
  uploadHref,
  emptyTitle = "아직 사진이 없습니다",
  emptyDescription = "이 날짜의 첫 번째 사진을 추가해 보세요.",
  showDate = false,
  onPhotoRemoved
}: {
  photos: Photo[];
  currentUserId: string;
  canDeleteAll: boolean;
  uploadHref: string;
  emptyTitle?: string;
  emptyDescription?: string;
  showDate?: boolean;
  onPhotoRemoved?: (photoId: string) => void;
}) {
  const router = useRouter();
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const items = photos.filter((photo) => !removedIds.has(photo.id));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [presentedId, setPresentedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [imageState, setImageState] = useState<ImageLoadState>({ photoId: "", status: "loading" });
  const [imageRequestKey, setImageRequestKey] = useState(0);
  const handleImageStatus = useCallback((photoId: string, status: ImageLoadState["status"]) => {
    setImageState({ photoId, status });
    setPresentedId((current) => nextPresentedPhotoId(current, photoId, status));
  }, []);
  const [zoom, setZoom] = useState<ZoomTransform>(INITIAL_ZOOM);
  const zoomRef = useRef<ZoomTransform>(INITIAL_ZOOM);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const current = zoomRef.current;
      const next = zoomAtPoint(current, event.deltaY, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
      if (next === current) return;
      zoomRef.current = next;
      setZoom(next);
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      if (viewportRef.current === viewport) viewportRef.current = null;
    };
  }, []);
  const selectedIndex = items.findIndex((photo) => photo.id === selectedId);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : null;
  const presentedIndex = items.findIndex((photo) => photo.id === presentedId);
  const presented = presentedIndex >= 0 ? items[presentedIndex] : selected;
  const imageReady = selected ? canInteractWithPhoto(selected.id, imageState) : false;

  function resetZoom() {
    const initial = { ...INITIAL_ZOOM };
    zoomRef.current = initial;
    setZoom(initial);
  }

  function changeZoom(deltaY: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = zoomRef.current;
    const next = zoomAtPoint(current, deltaY, {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2
    });
    zoomRef.current = next;
    setZoom(next);
  }

  function startSwipe(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    touchStartRef.current = touch && event.touches.length === 1
      ? { x: touch.clientX, y: touch.clientY }
      : null;
  }

  function endSwipe(event: TouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    const touch = event.changedTouches[0];
    touchStartRef.current = null;
    if (!start || !touch || zoomRef.current.scale !== 1) return;
    const direction = photoSwipeDirection(start, { x: touch.clientX, y: touch.clientY });
    if (direction) move(direction);
  }

  function moveTouch(event: TouchEvent<HTMLDivElement>) {
    const previous = touchStartRef.current;
    const touch = event.touches[0];
    const viewport = viewportRef.current;
    if (!previous || !touch || !viewport || zoomRef.current.scale <= 1) return;
    event.preventDefault();
    const next = panZoom(
      zoomRef.current,
      { x: touch.clientX - previous.x, y: touch.clientY - previous.y },
      { width: viewport.clientWidth, height: viewport.clientHeight }
    );
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    zoomRef.current = next;
    setZoom(next);
  }

  function close() {
    setSelectedId(null);
    setPresentedId(null);
    resetZoom();
    setError("");
  }

  function move(offset: number) {
    if (items.length < 2 || selectedIndex < 0) return;
    const index = (selectedIndex + offset + items.length) % items.length;
    setSelectedId(items[index].id);
    resetZoom();
    setError("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") move(-1);
    if (event.key === "ArrowRight") move(1);
  }

  async function remove() {
    if (!selected || !imageReady) return;
    setDeleting(true);
    setError("");
    try {
      await clientApi(`/photos/${selected.id}`, { method: "DELETE" });
      setRemovedIds((current) => new Set(current).add(selected.id));
      onPhotoRemoved?.(selected.id);
      close();
      if (!onPhotoRemoved) router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "사진을 삭제하지 못했습니다.");
    } finally {
      setDeleting(false);
    }
  }

  if (items.length === 0) {
    return (
      <Card className="rounded-2xl">
        <Button asChild variant="ghost" className="group h-auto w-full min-w-0 flex-col whitespace-normal break-words rounded-2xl px-5 py-14 text-center sm:py-20">
          <Link href={uploadHref}>
            <span className="mb-2 grid size-12 place-items-center rounded-xl bg-secondary text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary" aria-hidden="true">
              <ImagePlus />
            </span>
            <span className="font-semibold text-foreground">{emptyTitle}</span>
              <span className="text-pretty text-base font-normal leading-6 text-muted-foreground">{emptyDescription}</span>
              <span className="mt-3 text-[15px] font-bold text-primary">첫 사진 추가하기 →</span>
          </Link>
        </Button>
      </Card>
    );
  }

  function renderPhoto(photo: Photo) {
    return (
      <figure
        className="gallery-item relative transition-transform duration-150 hover:-translate-y-0.5"
        key={photo.id}
      >
        <Button
          variant="ghost"
          className="h-full w-full cursor-zoom-in rounded-none p-0"
          type="button"
          aria-label={`${photo.originalName} 크게 보기`}
          aria-haspopup="dialog"
          onClick={() => {
            setSelectedId(photo.id);
            setPresentedId(photo.id);
            resetZoom();
            setError("");
          }}
        >
          <PrivateImage
            photoId={photo.id}
            variant="thumbnail"
            alt={photo.originalName}
            className="h-full w-full object-cover"
          />
        </Button>
        {showDate || photo.childTags.length > 0 ? (
          <span className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-16px)] truncate rounded-md bg-black/60 px-2 py-1 text-xs font-semibold text-white backdrop-blur-sm">
            {showDate ? photo.albumDate.slice(0, 10) : ""}
            {showDate && photo.childTags.length > 0 ? " · " : ""}
            {photo.childTags.map((tag) => tag.name).join(" · ")}
          </span>
        ) : null}
      </figure>
    );
  }

  return (
    <>
      <VirtuosoGrid
        useWindowScroll
        data={items}
        computeItemKey={(_, photo) => photo.id}
        listClassName="gallery"
        itemClassName="gallery-cell"
        initialItemCount={Math.min(items.length, 40)}
        increaseViewportBy={{ top: 400, bottom: 800 }}
        itemContent={(_, photo) => renderPhoto(photo)}
      />

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) close(); }}>
        {selected && (
          <DialogContent className="photo-dialog max-w-none gap-0 p-0 text-white" showCloseButton={false} onKeyDown={handleKeyDown}>
          <div className="photo-dialog-content">
            <div className="flex min-h-14 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-5">
              <div className="min-w-0">
                <DialogTitle className="truncate text-[15px] font-semibold text-white">{presented?.originalName}</DialogTitle>
                <DialogDescription className="mt-0.5 text-sm text-white/60">
                  {(presentedIndex >= 0 ? presentedIndex : selectedIndex) + 1} / {items.length}
                  {showDate && presented ? ` · ${presented.albumDate.slice(0, 10)}` : ""}
                  {presented && presented.childTags.length > 0
                    ? ` · ${presented.childTags.map((tag) => tag.name).join(", ")}`
                    : " · 태그 없음"}
                </DialogDescription>
              </div>
              <DialogClose asChild>
                <Button variant="ghost" size="icon" className="shrink-0 rounded-full text-white/75 hover:bg-white/10 hover:text-white" aria-label="사진 닫기">
                  <X aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>

            <div className="photo-dialog-stage">
              <div
                className="photo-dialog-viewport"
                ref={setViewportRef}
                style={{ touchAction: zoom.scale > 1 ? "none" : "pan-y" }}
                onTouchStart={startSwipe}
                onTouchMove={moveTouch}
                onTouchEnd={endSwipe}
                onTouchCancel={() => { touchStartRef.current = null; }}
              >
                <div
                  className="photo-dialog-canvas"
                  style={{ transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }}
                >
                  <PrivateImage
                    photoId={selected.id}
                    variant="display"
                    alt={selected.originalName}
                    className="h-full w-full object-contain"
                    requestKey={imageRequestKey}
                    onStatusChange={handleImageStatus}
                  />
                </div>
                {!imageReady && (
                  <div
                    className="photo-dialog-status"
                    data-error={imageState.photoId === selected.id && imageState.status === "error"}
                  >
                    {imageState.photoId === selected.id && imageState.status === "error" ? (
                      <div className="flex flex-col items-center gap-3 text-center">
                        <p className="text-sm font-medium text-white" role="alert">사진을 불러오지 못했습니다.</p>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setImageRequestKey((key) => key + 1)}
                        >
                          다시 시도
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm font-medium text-white/80" role="status">사진 불러오는 중…</p>
                    )}
                  </div>
                )}
              </div>
              {items.length > 1 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="photo-dialog-arrow photo-dialog-arrow-previous"
                    type="button"
                    aria-label="이전 사진"
                    onClick={() => move(-1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="photo-dialog-arrow photo-dialog-arrow-next"
                    type="button"
                    aria-label="다음 사진"
                    onClick={() => move(1)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </>
              )}
            </div>

            <div className="photo-dialog-footer">
              <p className="invisible min-w-0 truncate text-xs text-white/55 sm:visible">
                ← → 키로 사진을 이동할 수 있어요
              </p>
              <div className="flex items-center gap-1 text-white">
                <Button variant="ghost" size="icon" type="button" disabled={!imageReady || zoom.scale <= 1} aria-label="축소" onClick={() => changeZoom(1)}>
                  <Minus aria-hidden="true" />
                </Button>
                <p className="min-w-10 text-center text-xs font-semibold tabular-nums text-white/70" aria-live="polite">
                  {Math.round(zoom.scale * 100)}%
                </p>
                <Button variant="ghost" size="icon" type="button" disabled={!imageReady || zoom.scale >= 4} aria-label="확대" onClick={() => changeZoom(-1)}>
                  <Plus aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="icon" type="button" disabled={!imageReady || zoom.scale === 1} aria-label="확대 초기화" onClick={resetZoom}>
                  <RotateCcw aria-hidden="true" />
                </Button>
              </div>
              <div className="flex min-w-0 items-center justify-end gap-2">
                {error && (
                  <p className="truncate text-xs font-medium text-[#ff8b82]" role="alert">
                    {error}
                  </p>
                )}
                {(canDeleteAll || selected.uploadedById === currentUserId) && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button aria-label={deleting ? "사진 삭제 중" : "사진 삭제"} variant="ghost" className="shrink-0 text-[#ff8b82] hover:bg-white/10 hover:text-[#ffaaa3]" disabled={deleting || !imageReady}>
                        <Trash2 aria-hidden="true" />
                        <span className="hidden sm:inline">{deleting ? "삭제 중…" : "사진 삭제"}</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>이 사진을 삭제할까요?</AlertDialogTitle>
                        <AlertDialogDescription>삭제한 사진은 복구할 수 없습니다.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>취소</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void remove()}>사진 삭제</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
