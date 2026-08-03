export type Family = {
  id: string;
  name: string;
  members: { role: "OWNER" | "MEMBER" }[];
  albums: Album[];
};

export type Album = {
  id: string;
  familyId: string;
  name: string;
  childName: string | null;
  birthDate: string | null;
  childTags: ChildTag[];
};

export type ChildTag = {
  id: string;
  albumId: string;
  name: string;
};

export type CalendarDay = {
  date: string;
  count: number;
  representativePhotoId: string | null;
};

export type Photo = {
  id: string;
  albumDate: string;
  originalName: string;
  uploadedById: string;
  createdAt: string;
  mediaAsset: { width: number; height: number };
  childTags: ChildTag[];
};

export type PhotoFeedPage = {
  items: Photo[];
  nextCursor: string | null;
};
