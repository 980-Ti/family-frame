import { afterEach, describe, expect, it } from "vitest";
import { env } from "../src/common/env.js";

const originalPort = process.env.PORT;
const originalSessionTtl = process.env.SESSION_TTL_DAYS;
const originalSignedUrlTtl = process.env.SIGNED_URL_TTL_SECONDS;
const originalMediaDeduplicationEnabled = process.env.MEDIA_DEDUPLICATION_ENABLED;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalSessionTtl === undefined) delete process.env.SESSION_TTL_DAYS;
  else process.env.SESSION_TTL_DAYS = originalSessionTtl;
  if (originalSignedUrlTtl === undefined) delete process.env.SIGNED_URL_TTL_SECONDS;
  else process.env.SIGNED_URL_TTL_SECONDS = originalSignedUrlTtl;
  if (originalMediaDeduplicationEnabled === undefined) delete process.env.MEDIA_DEDUPLICATION_ENABLED;
  else process.env.MEDIA_DEDUPLICATION_ENABLED = originalMediaDeduplicationEnabled;
});

describe("numeric environment configuration", () => {
  it("rejects invalid positive numbers", () => {
    process.env.PORT = "not-a-port";
    process.env.SESSION_TTL_DAYS = "0";
    process.env.SIGNED_URL_TTL_SECONDS = "1.5";

    expect(() => env.port).toThrow("PORT must be a positive integer");
    expect(() => env.sessionTtlDays).toThrow("SESSION_TTL_DAYS must be a positive number");
    expect(() => env.signedUrlTtl).toThrow("SIGNED_URL_TTL_SECONDS must be a positive integer");
  });

  it("parses valid values", () => {
    process.env.PORT = "4100";
    process.env.SESSION_TTL_DAYS = "14";
    process.env.SIGNED_URL_TTL_SECONDS = "600";

    expect(env.port).toBe(4100);
    expect(env.sessionTtlDays).toBe(14);
    expect(env.signedUrlTtl).toBe(600);
  });
});

describe("media deduplication environment configuration", () => {
  it("defaults to true when unset and rejects invalid values", () => {
    delete process.env.MEDIA_DEDUPLICATION_ENABLED;
    expect(env.mediaDeduplicationEnabled).toBe(true);

    process.env.MEDIA_DEDUPLICATION_ENABLED = "yes";
    expect(() => env.mediaDeduplicationEnabled).toThrow("MEDIA_DEDUPLICATION_ENABLED must be either true or false");

    process.env.MEDIA_DEDUPLICATION_ENABLED = "";
    expect(() => env.mediaDeduplicationEnabled).toThrow("MEDIA_DEDUPLICATION_ENABLED must be either true or false");
  });

  it("parses true and false values", () => {
    process.env.MEDIA_DEDUPLICATION_ENABLED = "true";
    expect(env.mediaDeduplicationEnabled).toBe(true);

    process.env.MEDIA_DEDUPLICATION_ENABLED = "false";
    expect(env.mediaDeduplicationEnabled).toBe(false);
  });
});
