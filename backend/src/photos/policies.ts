import { ConflictException } from "@nestjs/common";
import type { FamilyRole } from "../generated/prisma/enums.js";

export function assertDailyPhotoCapacity(activeCount: number): void {
  if (activeCount >= 10) {
    throw new ConflictException({
      code: "DAILY_PHOTO_LIMIT",
      message: "하루에는 사진을 최대 10장까지 올릴 수 있습니다."
    });
  }
}

export function canDeletePhoto(
  role: FamilyRole,
  currentUserId: string,
  uploadedById: string
): boolean {
  return role === "OWNER" || currentUserId === uploadedById;
}
