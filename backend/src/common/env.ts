function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === "") {
    throw new Error(`${name} must be either true or false`);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

export const env = {
  get port() {
    return positiveInteger("PORT", 4000);
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get appOrigin() {
    return process.env.APP_ORIGIN ?? "http://localhost:3000";
  },
  get sessionCookieName() {
    return process.env.SESSION_COOKIE_NAME ?? "family_frame_session";
  },
  get sessionTtlDays() {
    return positiveNumber("SESSION_TTL_DAYS", 7);
  },
  get signedUrlTtl() {
    return positiveInteger("SIGNED_URL_TTL_SECONDS", 300);
  },
  get mediaDeduplicationEnabled() {
    return boolean("MEDIA_DEDUPLICATION_ENABLED", true);
  },
  get s3() {
    return {
      endpoint: required("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "us-east-1",
      bucket: required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      signedUrlTtl: env.signedUrlTtl
    };
  }
};
