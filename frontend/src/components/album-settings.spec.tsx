import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AlbumSettings } from "./album-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

describe("album child tag settings", () => {
  it("offers an accessible remove action for each tag", () => {
    const markup = renderToStaticMarkup(
      <AlbumSettings
        familyId="family-1"
        albumId="album-1"
        childTags={[{ id: "tag-1", albumId: "album-1", name: "민서" }]}
        isOwner
      />
    );

    expect(markup).toContain('aria-label="민서 이름표 삭제"');
  });

  it("shows a useful empty state without hiding the add form", () => {
    const markup = renderToStaticMarkup(
      <AlbumSettings
        familyId="family-1"
        albumId="album-1"
        childTags={[]}
        isOwner
      />
    );

    expect(markup).toContain("아직 추가한 아이 이름이 없어요.");
    expect(markup).toContain("아이 추가");
  });
});
