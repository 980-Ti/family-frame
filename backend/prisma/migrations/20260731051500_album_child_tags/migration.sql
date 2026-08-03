-- Preserve existing album data while moving child names to album-scoped tags.
ALTER TABLE "Album" ALTER COLUMN "childName" DROP NOT NULL;

CREATE TABLE "ChildTag" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChildTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PhotoChildTag" (
    "photoId" TEXT NOT NULL,
    "childTagId" TEXT NOT NULL,

    CONSTRAINT "PhotoChildTag_pkey" PRIMARY KEY ("photoId","childTagId")
);

CREATE UNIQUE INDEX "ChildTag_albumId_name_key" ON "ChildTag"("albumId", "name");
CREATE INDEX "ChildTag_albumId_idx" ON "ChildTag"("albumId");
CREATE INDEX "PhotoChildTag_childTagId_idx" ON "PhotoChildTag"("childTagId");

ALTER TABLE "ChildTag"
ADD CONSTRAINT "ChildTag_albumId_fkey"
FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PhotoChildTag"
ADD CONSTRAINT "PhotoChildTag_photoId_fkey"
FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PhotoChildTag"
ADD CONSTRAINT "PhotoChildTag_childTagId_fkey"
FOREIGN KEY ("childTagId") REFERENCES "ChildTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ChildTag" ("id", "albumId", "name")
SELECT "id" || '_legacy_child', "id", btrim("childName")
FROM "Album"
WHERE "childName" IS NOT NULL AND btrim("childName") <> '';

INSERT INTO "PhotoChildTag" ("photoId", "childTagId")
SELECT photo."id", photo."albumId" || '_legacy_child'
FROM "Photo" AS photo
JOIN "ChildTag" AS tag
  ON tag."id" = photo."albumId" || '_legacy_child';
