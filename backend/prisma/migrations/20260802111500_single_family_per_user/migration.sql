DROP INDEX "FamilyMember_userId_idx";

CREATE UNIQUE INDEX "FamilyMember_userId_key" ON "FamilyMember"("userId");
