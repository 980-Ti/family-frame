import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../src/common/prisma.service.js";
import { FamiliesService } from "../src/families/families.service.js";

describe("single family membership", () => {
  it("does not create a second family for the same user", async () => {
    const create = vi.fn();
    const prisma = {
      familyMember: { findFirst: async () => ({ familyId: "family-1" }) },
      family: { create }
    } as unknown as PrismaService;

    await expect(new FamiliesService(prisma).create("user-1", "새 가족"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not accept an invitation to a second family", async () => {
    const transaction = vi.fn();
    const prisma = {
      familyInvite: {
        findUnique: async () => ({
          id: "invite-1",
          familyId: "family-2",
          email: "parent@example.com",
          acceptedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          family: { id: "family-2", name: "다른 가족" }
        })
      },
      user: { findUniqueOrThrow: async () => ({ id: "user-1", email: "parent@example.com" }) },
      familyMember: { findFirst: async () => ({ familyId: "family-1" }) },
      $transaction: transaction
    } as unknown as PrismaService;

    await expect(new FamiliesService(prisma).acceptInvite("user-1", "token"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
