import { notFound } from "next/navigation";
import { AlbumBrowserHeader } from "@/components/album-browser-header";
import { ChildTagFilter } from "@/components/child-tag-filter";
import { PhotoFeed } from "@/components/photo-feed";
import {
  parsePhotoFilter,
  photoFilterApiParams,
  photoFilterKey
} from "@/lib/photo-filter";
import { currentAlbumMonth } from "@/lib/photo-date";
import { protectedApi } from "@/lib/protected-api";
import type { Family, PhotoFeedPage } from "@/lib/types";

export default async function PhotosPage({
  params,
  searchParams
}: {
  params: Promise<{ familyId: string; albumId: string }>;
  searchParams: Promise<{
    tag?: string;
    tags?: string;
    match?: string;
    untagged?: string;
  }>;
}) {
  const { familyId, albumId } = await params;
  const filter = parsePhotoFilter(await searchParams);
  const apiQuery = photoFilterApiParams(filter, { take: "40" });
  const feedPath = `/albums/${albumId}/photo-feed?${apiQuery}`;
  const [initialPage, families, session] = await Promise.all([
    protectedApi<PhotoFeedPage>(feedPath),
    protectedApi<Family[]>("/families"),
    protectedApi<{ user: { id: string } }>("/auth/me")
  ]);
  const family = families.find((item) => item.id === familyId);
  const album = family?.albums.find((item) => item.id === albumId);
  if (!family || !album) notFound();

  const selectedNames = album.childTags
    .filter((tag) => filter.childTagIds.includes(tag.id))
    .map((tag) => tag.name);
  const emptyTitle = filter.untagged
    ? "태그 없는 사진이 없습니다"
    : selectedNames.length > 1
      ? filter.match === "all"
        ? `${selectedNames.join("·")}가 함께 나온 사진이 없습니다`
        : `${selectedNames.join("·")} 중 선택한 아이가 나온 사진이 없습니다`
      : selectedNames.length === 1
        ? `${selectedNames[0]} 사진이 없습니다`
        : "아직 앨범에 사진이 없습니다";
  const month = currentAlbumMonth();

  return (
    <section>
      <AlbumBrowserHeader
        family={family}
        album={album}
        month={month}
        filter={filter}
        activeView="photos"
      />
      <ChildTagFilter
        baseHref={`/families/${familyId}/albums/${albumId}/photos`}
        childTags={album.childTags}
        filter={filter}
      />
      <PhotoFeed
        key={photoFilterKey(filter)}
        initialPage={initialPage}
        feedPath={feedPath}
        currentUserId={session.user.id}
        canDeleteAll={family.members[0]?.role === "OWNER"}
        uploadHref={`/families/${familyId}/albums/${albumId}/upload`}
        emptyTitle={emptyTitle}
      />
    </section>
  );
}
