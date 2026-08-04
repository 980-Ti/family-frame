import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VideoCommandRunner = (command: string, args: string[]) => Promise<string>;

export class InvalidVideoError extends Error {
  constructor() {
    super("INVALID_VIDEO");
  }
}

export class VideoProcessorUnavailableError extends Error {
  constructor() {
    super("VIDEO_PROCESSOR_UNAVAILABLE");
  }
}

const runVideoCommand: VideoCommandRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(
    command,
    args,
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5 * 60_000 },
    (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    }
  );
});

type ProbeResult = {
  format?: { format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
};

export async function processMp4(
  source: Buffer,
  runner: VideoCommandRunner = runVideoCommand
): Promise<{ mimeType: "video/mp4"; width: number; height: number; thumbnail: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), "family-frame-video-"));
  const input = join(directory, "input.mp4");
  const thumbnail = join(directory, "thumbnail.webp");

  try {
    await writeFile(input, source);
    let probe: ProbeResult;
    try {
      probe = JSON.parse(await runner("ffprobe", [
        "-v", "error",
        "-show_entries", "format=format_name:stream=codec_type,codec_name,width,height",
        "-of", "json",
        input
      ])) as ProbeResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new VideoProcessorUnavailableError();
      }
      throw new InvalidVideoError();
    }

    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    if (
      !probe.format?.format_name?.split(",").includes("mp4")
      || video?.codec_name !== "h264"
      || !video.width
      || !video.height
      || audio.some((stream) => stream.codec_name !== "aac")
    ) {
      throw new InvalidVideoError();
    }

    try {
      await runner("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", input,
        "-frames:v", "1",
        "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320",
        thumbnail
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new VideoProcessorUnavailableError();
      }
      throw new InvalidVideoError();
    }

    return {
      mimeType: "video/mp4",
      width: video.width,
      height: video.height,
      thumbnail: await readFile(thumbnail)
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
