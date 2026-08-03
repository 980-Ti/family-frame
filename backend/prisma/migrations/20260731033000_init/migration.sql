CREATE TYPE "FamilyRole" AS ENUM ('OWNER', 'MEMBER');
CREATE TYPE "PhotoStatus" AS ENUM ('PENDING_UPLOAD', 'PROCESSING', 'READY', 'FAILED', 'DELETED');
CREATE TYPE "AssetStatus" AS ENUM ('READY', 'ORPHANED');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Family" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Family_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FamilyMember" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "FamilyRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FamilyMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FamilyInvite" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FamilyInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Album" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "childName" TEXT NOT NULL,
  "birthDate" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "originalKey" TEXT NOT NULL,
  "displayKey" TEXT NOT NULL,
  "thumbnailKey" TEXT NOT NULL,
  "status" "AssetStatus" NOT NULL DEFAULT 'READY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Photo" (
  "id" TEXT NOT NULL,
  "albumId" TEXT NOT NULL,
  "mediaAssetId" TEXT,
  "uploadedById" TEXT NOT NULL,
  "albumDate" DATE NOT NULL,
  "clientUploadId" TEXT NOT NULL,
  "tempObjectKey" TEXT,
  "originalName" TEXT NOT NULL,
  "status" "PhotoStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DailyRepresentative" (
  "id" TEXT NOT NULL,
  "albumId" TEXT NOT NULL,
  "albumDate" DATE NOT NULL,
  "photoId" TEXT NOT NULL,
  CONSTRAINT "DailyRepresentative_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "FamilyMember_familyId_userId_key" ON "FamilyMember"("familyId", "userId");
CREATE INDEX "FamilyMember_userId_idx" ON "FamilyMember"("userId");
CREATE UNIQUE INDEX "FamilyInvite_tokenHash_key" ON "FamilyInvite"("tokenHash");
CREATE INDEX "FamilyInvite_familyId_idx" ON "FamilyInvite"("familyId");
CREATE INDEX "Album_familyId_idx" ON "Album"("familyId");
CREATE UNIQUE INDEX "MediaAsset_familyId_sha256_key" ON "MediaAsset"("familyId", "sha256");
CREATE INDEX "MediaAsset_familyId_idx" ON "MediaAsset"("familyId");
CREATE UNIQUE INDEX "Photo_albumId_clientUploadId_key" ON "Photo"("albumId", "clientUploadId");
CREATE INDEX "Photo_albumId_albumDate_status_idx" ON "Photo"("albumId", "albumDate", "status");
CREATE INDEX "Photo_mediaAssetId_idx" ON "Photo"("mediaAssetId");
CREATE UNIQUE INDEX "DailyRepresentative_photoId_key" ON "DailyRepresentative"("photoId");
CREATE UNIQUE INDEX "DailyRepresentative_albumId_albumDate_key" ON "DailyRepresentative"("albumId", "albumDate");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FamilyInvite" ADD CONSTRAINT "FamilyInvite_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FamilyInvite" ADD CONSTRAINT "FamilyInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Album" ADD CONSTRAINT "Album_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyRepresentative" ADD CONSTRAINT "DailyRepresentative_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyRepresentative" ADD CONSTRAINT "DailyRepresentative_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
