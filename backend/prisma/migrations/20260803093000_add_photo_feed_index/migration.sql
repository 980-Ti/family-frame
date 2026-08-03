CREATE INDEX "Photo_feed_idx"
ON "Photo"("albumId", "status", "albumDate" DESC, "createdAt" DESC, "id" DESC);
