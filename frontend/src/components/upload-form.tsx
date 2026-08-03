"use client";

import exifr from "exifr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ImagePlus, LoaderCircle, Trash2, Upload } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientApi } from "@/lib/api";
import {
  suggestPhotoDate,
  type PhotoDateSource
} from "@/lib/photo-date";
import type { ChildTag } from "@/lib/types";

export type PendingPhoto = {
  id: string;
  file: File;
  albumDate: string;
  capturedAt: string | null;
  dateSource: PhotoDateSource;
  childTagIds: string[];
  previewUrl: string;
  status: "ready" | "uploading" | "done" | "error";
  error?: string;
};

type UploadStart = {
  photoId: string;
  uploadUrl: string | null;
};

const DATE_SOURCE_LABEL: Record<PhotoDateSource, string> = {
  EXIF_ORIGINAL: "사진 촬영일",
  EXIF_CREATED: "사진 생성일",
  FILE_MODIFIED: "파일 날짜",
  USER: "직접 선택",
  DEFAULT: "오늘"
};

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function contentType(file: File) {
  return file.type;
}

export async function uploadPhotoObject(url: string, file: File): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType(file) },
      body: file,
      signal: AbortSignal.timeout(300_000)
    });
  } catch {
    throw new Error("사진 전송 시간이 초과되었거나 연결이 끊겼습니다.");
  }
  if (!response.ok) throw new Error("사진 전송에 실패했습니다.");
}

export function uploadStartPayload(photo: PendingPhoto) {
  return {
    date: photo.albumDate,
    capturedAt: photo.capturedAt ?? undefined,
    dateSource: photo.dateSource,
    originalName: photo.file.name,
    contentType: contentType(photo.file),
    fileSize: photo.file.size,
    clientUploadId: photo.id,
    childTagIds: photo.childTagIds
  };
}

export function UploadForm({
  familyId,
  albumId,
  defaultDate,
  childTags
}: {
  familyId: string;
  albumId: string;
  defaultDate?: string;
  childTags: ChildTag[];
}) {
  const router = useRouter();
  const previewUrls = useRef(new Set<string>());
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const month = (defaultDate ?? localToday()).slice(0, 7);
  const backHref = defaultDate
    ? `/families/${familyId}/albums/${albumId}/date/${defaultDate}`
    : `/families/${familyId}/albums/${albumId}/calendar?month=${month}`;

  useEffect(() => {
    const urls = previewUrls.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  async function selectPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setMessage("");

    if (!files.length) return;
    if (files.length > 10) {
      setMessage("사진은 한 번에 최대 10장까지 선택할 수 있어요.");
      return;
    }
    if (files.some((file) => file.size > 20 * 1024 * 1024)) {
      setMessage("사진 한 장의 크기는 20MB 이하여야 해요.");
      return;
    }
    if (files.some((file) => !ALLOWED_TYPES.has(contentType(file)))) {
      setMessage("JPG, PNG, WebP 사진만 올릴 수 있어요.");
      return;
    }

    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current.clear();
    setPhotos([]);
    setReading(true);
    try {
      const nextPhotos: PendingPhoto[] = [];
      for (const file of files) {
        const metadata = await exifr
          .parse(file, ["DateTimeOriginal", "CreateDate"])
          .catch(() => undefined) as
          | { DateTimeOriginal?: Date; CreateDate?: Date }
          | undefined;
        const suggestion = suggestPhotoDate({
          defaultDate,
          dateTimeOriginal: metadata?.DateTimeOriginal,
          createDate: metadata?.CreateDate,
          fileLastModified: file.lastModified
            ? new Date(file.lastModified)
            : undefined,
          today: localToday()
        });

        nextPhotos.push({
          id: crypto.randomUUID(),
          file,
          childTagIds: selectedTagIds,
          previewUrl: URL.createObjectURL(file),
          status: "ready",
          ...suggestion
        });
      }
      nextPhotos.forEach((photo) => previewUrls.current.add(photo.previewUrl));
      setPhotos(nextPhotos);
    } finally {
      setReading(false);
    }
  }

  function changeDate(id: string, albumDate: string) {
    setPhotos((current) =>
      current.map((photo) =>
        photo.id === id
          ? { ...photo, albumDate, dateSource: "USER" }
          : photo
      )
    );
  }

  function toggleTag(id: string) {
    const next = selectedTagIds.includes(id)
      ? selectedTagIds.filter((tagId) => tagId !== id)
      : [...selectedTagIds, id];
    setSelectedTagIds(next);
    setPhotos((photos) =>
      photos.map((photo) =>
        photo.status === "done" ? photo : { ...photo, childTagIds: next }
      )
    );
  }

  function togglePhotoTag(photoId: string, tagId: string) {
    setPhotos((current) =>
      current.map((photo) =>
        photo.id !== photoId
          ? photo
          : {
              ...photo,
              childTagIds: photo.childTagIds.includes(tagId)
                ? photo.childTagIds.filter((id) => id !== tagId)
                : [...photo.childTagIds, tagId]
            }
      )
    );
  }

  function removePhoto(photo: PendingPhoto) {
    URL.revokeObjectURL(photo.previewUrl);
    previewUrls.current.delete(photo.previewUrl);
    setPhotos((current) => current.filter((item) => item.id !== photo.id));
  }

  async function upload() {
    const pendingPhotos = photos.filter((photo) => photo.status !== "done");
    if (!pendingPhotos.length) return;
    setUploading(true);
    setMessage("");
    let completed = 0;
    let failed = 0;
    try {
      for (const photo of pendingPhotos) {
        setPhotos((current) =>
          current.map((item) =>
            item.id === photo.id
              ? { ...item, status: "uploading", error: undefined }
              : item
          )
        );
        try {
          const start = await clientApi<UploadStart>(
            `/albums/${albumId}/uploads`,
            {
              method: "POST",
              body: JSON.stringify(uploadStartPayload(photo))
            }
          );
          if (start.uploadUrl) {
            await uploadPhotoObject(start.uploadUrl, photo.file);
          }
          await clientApi(`/photos/${start.photoId}/complete`, {
            method: "POST"
          }, 120_000);
          completed += 1;
          setPhotos((current) =>
            current.map((item) =>
              item.id === photo.id ? { ...item, status: "done" } : item
            )
          );
        } catch (error) {
          failed += 1;
          const detail = error instanceof Error
            ? error.message
            : "사진을 올리지 못했습니다.";
          setPhotos((current) =>
            current.map((item) =>
              item.id === photo.id
                ? { ...item, status: "error", error: detail }
                : item
            )
          );
        }
      }

      if (failed) {
        setMessage(`${completed}장 완료 · ${failed}장 실패했습니다. 실패한 사진만 다시 시도해 주세요.`);
        return;
      }
      const dates = [...new Set(photos.map((photo) => photo.albumDate))];
      router.push(
        dates.length === 1
          ? `/families/${familyId}/albums/${albumId}/date/${dates[0]}`
          : `/families/${familyId}/albums/${albumId}/calendar?month=${dates[0].slice(0, 7)}`
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="mx-auto max-w-2xl">
      <Button asChild variant="link" className="page-back mb-4">
        <Link href={backHref}>
          <ArrowLeft aria-hidden="true" />
          앨범으로 돌아가기
        </Link>
      </Button>
      <p className="eyebrow mb-2">앨범에 기록하기</p>
      <h1 className="brand text-3xl font-extrabold sm:text-4xl">사진 추가</h1>
      <p className="muted mt-2 text-base leading-7">
        촬영일을 찾으면 날짜를 먼저 채워드려요. 올리기 전에 확인하거나
        바꿀 수 있습니다.
      </p>

      {childTags.length > 0 && (
        <fieldset className="mt-7 rounded-2xl border border-border bg-card p-5 shadow-[0_2px_8px_rgb(17_24_39/0.04)] sm:p-6">
          <legend className="px-1 text-[15px] font-bold">사진에 나온 아이</legend>
          <p className="muted mt-1 text-[15px]">
            모든 사진의 기본 태그예요. 아래에서 사진마다 바꿀 수 있습니다.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {childTags.map((tag) => {
              const selected = selectedTagIds.includes(tag.id);
              return (
                <Label
                  key={tag.id}
                  htmlFor={`upload-tag-${tag.id}`}
                  data-selected={selected}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 transition-colors hover:bg-secondary data-[selected=true]:border-primary/30 data-[selected=true]:bg-primary/5 data-[selected=true]:text-primary"
                >
                  <Checkbox
                    id={`upload-tag-${tag.id}`}
                    checked={selected}
                    onCheckedChange={() => toggleTag(tag.id)}
                    disabled={uploading}
                  />
                  {tag.name}
                </Label>
              );
            })}
          </div>
        </fieldset>
      )}

      <label className="upload-dropzone mt-6 flex min-h-44 cursor-pointer flex-col items-center justify-center px-6 text-center">
        <ImagePlus className="mb-3 size-6 text-primary" aria-hidden="true" />
        <span className="text-base font-bold">
          {reading ? "날짜를 확인하고 있어요…" : "사진 선택"}
        </span>
        <span className="muted mt-2 text-[15px]">
          JPG, PNG, WebP · 한 번에 최대 10장
        </span>
        <input
          className="sr-only"
          name="photos"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={reading || uploading}
          onChange={selectPhotos}
        />
      </label>

      {photos.length > 0 && (
        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">사진별 정보 확인</h2>
            <span className="muted text-sm">{photos.length}장</span>
          </div>
          {photos.map((photo) => (
            <Card
              key={photo.id}
              className="rounded-xl p-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                {/* Browser object URLs are required here; Next/Image cannot preview local files. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.previewUrl}
                  alt=""
                  width={80}
                  height={80}
                  loading="lazy"
                  decoding="async"
                  className="size-16 shrink-0 rounded-lg bg-secondary object-cover sm:size-20"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{photo.file.name}</p>
                  <p className="muted mt-1 text-xs">{DATE_SOURCE_LABEL[photo.dateSource]} 기준</p>
                  <p className="mt-1 flex items-center gap-1 text-xs font-semibold" aria-live="polite">
                    {photo.status === "uploading" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
                    {photo.status === "done" && <Check className="size-3.5 text-primary" aria-hidden="true" />}
                    {photo.status === "ready" && "업로드 대기"}
                    {photo.status === "uploading" && "업로드 중"}
                    {photo.status === "done" && "완료"}
                    {photo.status === "error" && <span className="text-destructive">실패 · {photo.error}</span>}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  disabled={uploading || photo.status === "done"}
                  onClick={() => removePhoto(photo)}
                  aria-label={`${photo.file.name} 선택 해제`}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              <Label className="mt-4 block">
                <span className="sr-only">{photo.file.name} 앨범 날짜</span>
                <Input
                  type="date"
                  value={photo.albumDate}
                  required
                  disabled={uploading || photo.status === "done"}
                  onChange={(event) =>
                    changeDate(photo.id, event.target.value)
                  }
                />
              </Label>
              {childTags.length > 0 && (
                <fieldset className="mt-3">
                  <legend className="muted text-xs font-semibold">사진에 나온 아이</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {childTags.map((tag) => {
                      const selected = photo.childTagIds.includes(tag.id);
                      return (
                        <Label
                          key={tag.id}
                          htmlFor={`photo-${photo.id}-tag-${tag.id}`}
                          data-selected={selected}
                          className="flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm data-[selected=true]:border-primary/30 data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
                        >
                          <Checkbox
                            id={`photo-${photo.id}-tag-${tag.id}`}
                            checked={selected}
                            disabled={uploading || photo.status === "done"}
                            onCheckedChange={() => togglePhotoTag(photo.id, tag.id)}
                          />
                          {tag.name}
                        </Label>
                      );
                    })}
                  </div>
                </fieldset>
              )}
            </Card>
          ))}
          <Button
            className="mt-2 w-full"
            type="button"
            disabled={uploading || photos.some((photo) => !photo.albumDate) || photos.every((photo) => photo.status === "done")}
            onClick={upload}
          >
            <Upload aria-hidden="true" />
            {uploading
              ? "사진을 올리고 있어요…"
              : photos.some((photo) => photo.status === "error")
                ? `실패한 ${photos.filter((photo) => photo.status === "error").length}장 다시 올리기`
                : `${photos.filter((photo) => photo.status !== "done").length}장 올리기`}
          </Button>
        </div>
      )}

      {message ? (
        <Alert variant="destructive" className="mt-4" role="status" aria-live="polite">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
