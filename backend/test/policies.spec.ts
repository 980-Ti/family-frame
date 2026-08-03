import { describe, expect, it } from "vitest";
import { assertDailyPhotoCapacity, canDeletePhoto } from "../src/photos/policies.js";

describe("photo policies", () => {
  it("rejects an eleventh active photo for the same date", () => {
    try {
      assertDailyPhotoCapacity(10);
      throw new Error("expected daily limit rejection");
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: "DAILY_PHOTO_LIMIT"
      });
    }
  });

  it("lets owners delete any photo and members only their own", () => {
    expect(canDeletePhoto("OWNER", "owner", "member")).toBe(true);
    expect(canDeletePhoto("MEMBER", "member", "member")).toBe(true);
    expect(canDeletePhoto("MEMBER", "member", "other")).toBe(false);
  });
});
