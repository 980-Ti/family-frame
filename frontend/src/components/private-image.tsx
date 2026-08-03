"use client";

import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { clientApi } from "@/lib/api";

export type PrivateImageVariant = "thumbnail" | "display";

type CachedUrl = { url: string; expiresAt: number };
type ImageSource = {
  photoId: string;
  variant: PrivateImageVariant;
  url: string;
  alt: string;
};

const signedUrlCache = new Map<string, CachedUrl>();
const SIGNED_URL_CACHE_MS = 60_000;
export const MAX_SIGNED_URL_CACHE_ENTRIES = 160;

function imageKey(photoId: string, variant: PrivateImageVariant) {
  return `${photoId}:${variant}`;
}

export function clearPrivateImageUrlCache(photoId?: string, variant?: PrivateImageVariant) {
  if (!photoId) {
    signedUrlCache.clear();
    return;
  }
  if (variant) {
    signedUrlCache.delete(imageKey(photoId, variant));
    return;
  }
  signedUrlCache.delete(imageKey(photoId, "thumbnail"));
  signedUrlCache.delete(imageKey(photoId, "display"));
}

export async function getPrivateImageUrl(
  photoId: string,
  variant: PrivateImageVariant,
  signal?: AbortSignal
) {
  const key = imageKey(photoId, variant);
  const cached = signedUrlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }
  if (cached) signedUrlCache.delete(key);

  const result = await clientApi<{ url: string }>(
    `/photos/${photoId}/url?variant=${variant}`,
    { signal }
  );
  signedUrlCache.set(key, {
    url: result.url,
    expiresAt: Date.now() + SIGNED_URL_CACHE_MS
  });
  if (signedUrlCache.size > MAX_SIGNED_URL_CACHE_ENTRIES) signedUrlCache.delete(signedUrlCache.keys().next().value!);
  return result.url;
}

export function shouldRequestPrivateImage(
  variant: PrivateImageVariant,
  visibleKey: string | null,
  key: string
) {
  return variant === "display" || visibleKey === key;
}

export function PrivateImage({
  photoId,
  variant = "thumbnail",
  alt,
  className,
  requestKey = 0,
  onStatusChange
}: {
  photoId: string;
  variant?: PrivateImageVariant;
  alt: string;
  className?: string;
  requestKey?: number;
  onStatusChange?: (photoId: string, status: "loading" | "ready" | "error") => void;
}) {
  const key = imageKey(photoId, variant);
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  const [source, setSource] = useState<ImageSource>();
  const [reloadKey, setReloadKey] = useState(0);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const retryRef = useRef({ scope: "", attempted: false });
  const onStatusRef = useRef(onStatusChange);
  const shouldRequest = shouldRequestPrivateImage(variant, visibleKey, key);

  useEffect(() => {
    onStatusRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (variant === "display") return;
    const target = targetRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setVisibleKey(key);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisibleKey(key);
      observer.disconnect();
    }, { rootMargin: "320px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [key, variant]);

  useEffect(() => {
    if (!shouldRequest) return;
    const controller = new AbortController();
    onStatusRef.current?.(photoId, "loading");

    void getPrivateImageUrl(photoId, variant, controller.signal)
      .then(async (url) => {
        if (variant === "display") {
          const image = new window.Image();
          image.src = url;
          await image.decode();
        }
        if (controller.signal.aborted) return;
        setSource({ photoId, variant, url, alt });
        onStatusRef.current?.(photoId, "ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        clearPrivateImageUrlCache(photoId, variant);
        onStatusRef.current?.(photoId, "error");
      });

    return () => controller.abort();
  }, [alt, photoId, reloadKey, requestKey, shouldRequest, variant]);

  const displayedSource = variant === "display"
    ? source
    : source?.photoId === photoId && source.variant === variant
      ? source
      : undefined;

  function handleImageError() {
    if (!displayedSource || displayedSource.photoId !== photoId) return;
    clearPrivateImageUrlCache(photoId, variant);
    const retryScope = `${key}:${requestKey}`;
    if (retryRef.current.scope !== retryScope) {
      retryRef.current = { scope: retryScope, attempted: false };
    }
    if (!retryRef.current.attempted) {
      retryRef.current.attempted = true;
      setReloadKey((current) => current + 1);
      return;
    }
    onStatusRef.current?.(photoId, "error");
  }

  if (!displayedSource) {
    return (
      <Skeleton
        ref={targetRef}
        className={className}
        aria-hidden={alt === "" ? true : undefined}
        aria-label={alt ? `${alt} 불러오는 중` : undefined}
      />
    );
  }

  return (
    // Backend-generated, short-lived signed derivatives are already resized for each view.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={displayedSource.url}
      alt={displayedSource.alt}
      width={640}
      height={640}
      loading={variant === "display" ? "eager" : "lazy"}
      decoding="async"
      onError={handleImageError}
    />
  );
}
