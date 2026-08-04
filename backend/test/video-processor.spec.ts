import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { processMp4, type VideoCommandRunner } from "../src/media/video-processor.js";

describe("MP4 processing", () => {
  it("accepts H.264/AAC MP4 and produces a thumbnail", async () => {
    const runner: VideoCommandRunner = async (command, args) => {
      if (command === "ffprobe") {
        return JSON.stringify({
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
            { codec_type: "audio", codec_name: "aac" }
          ]
        });
      }

      await writeFile(args.at(-1)!, Buffer.from("webp-thumbnail"));
      return "";
    };

    await expect(processMp4(Buffer.from("mp4-source"), runner)).resolves.toMatchObject({
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      thumbnail: Buffer.from("webp-thumbnail")
    });
  });
});
