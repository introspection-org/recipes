import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  SlackBotSession,
  type SlackBotSessionOptions,
  type SlackHttpResponse,
} from "./client.js";
import { slackDownloadRoot } from "./runtime.js";

export const MAX_SLACK_FILE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SLACK_FILES_HOST = "files.slack.com";

export type SlackFileVariant = "original" | "video_low";

export interface SlackDownloadResult {
  id: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  sha256: string;
}

interface SlackFileMetadata {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  mp4_low?: string;
}

export interface SlackFileSessionOptions extends SlackBotSessionOptions {
  cwd?: string;
}

interface SlackFileWriter {
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
  ): Promise<{ bytesWritten: number }>;
}

function requiredFileId(value: unknown): string {
  if (typeof value !== "string") throw new Error("file_id must be a string");
  const cleaned = value.trim();
  if (!cleaned) throw new Error("file_id is required");
  if (cleaned.length > 100) throw new Error("file_id exceeds 100 characters");
  return cleaned;
}

function fileVariant(value: unknown): SlackFileVariant {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "original"
  ) {
    return "original";
  }
  if (value === "video_low") return "video_low";
  throw new Error('variant must be "original" or "video_low"');
}

function safeSegment(value: unknown, fallback: string): string {
  const cleaned = basename(String(value ?? "")).replaceAll(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function downloadName(
  fileId: string,
  name: unknown,
  variant: SlackFileVariant,
): string {
  const id = safeSegment(fileId, "file");
  const base = safeSegment(name, "download");
  if (variant === "video_low") {
    const stem = base.replace(/\.[^.]+$/, "");
    return `${id}-video-low-${stem || "download"}.mp4`;
  }
  return `${id}-${base}`;
}

function downloadUrl(file: SlackFileMetadata, variant: SlackFileVariant): URL {
  let raw: string | undefined;
  if (variant === "video_low") {
    if (!file.mp4_low) throw new Error("file has no video_low rendition");
    if (
      typeof file.mimetype !== "string" ||
      !file.mimetype.startsWith("video/")
    ) {
      throw new Error("video_low is only available for video files");
    }
    raw = file.mp4_low;
  } else {
    raw = file.url_private_download || file.url_private;
  }
  if (!raw) throw new Error("file has no downloadable URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== SLACK_FILES_HOST) {
    throw new Error(`file URL host is not ${SLACK_FILES_HOST}`);
  }
  return url;
}

function declaredSize(file: SlackFileMetadata): number {
  if (
    typeof file.size !== "number" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0
  ) {
    throw new Error("file metadata carries no usable size");
  }
  return file.size;
}

export class SlackFileSession extends SlackBotSession {
  private readonly cwd: string;

  constructor(options: SlackFileSessionOptions = {}) {
    super(options);
    this.cwd = options.cwd ?? process.cwd();
  }

  async downloadFile(input: {
    file_id: string;
    variant?: string;
  }, signal?: AbortSignal): Promise<SlackDownloadResult> {
    const fileId = requiredFileId(input.file_id);
    const variant = fileVariant(input.variant);
    const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const info = (await this.call(
      "files.info",
      { file: fileId },
      "form",
      requestSignal,
    )) as {
      ok?: boolean;
      file?: SlackFileMetadata;
    };
    const file = info.file;
    if (!file || file.id !== fileId) {
      throw new Error("files.info returned a different file");
    }

    const size = declaredSize(file);
    if (variant === "original" && size > MAX_SLACK_FILE_BYTES) {
      throw new Error(
        `file is ${size} bytes; the download limit is ${MAX_SLACK_FILE_BYTES}`,
      );
    }

    const url = downloadUrl(file, variant);
    const root = slackDownloadRoot(this.env, this.cwd);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = resolve(root, downloadName(fileId, file.name, variant));
    const response = await this.request(url, {
      headers: {},
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Slack file download returned HTTP ${response.status}`);
    }

    const written = await writeDownload(
      response,
      destination,
      variant === "original" ? size : null,
      requestSignal,
    );
    return {
      id: fileId,
      name: basename(destination),
      path: destination,
      mime_type:
        variant === "video_low"
          ? "video/mp4"
          : file.mimetype || "application/octet-stream",
      size: written.size,
      sha256: written.sha256,
    };
  }
}

async function writeDownload(
  response: SlackHttpResponse,
  destination: string,
  expectedSize: number | null,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > MAX_SLACK_FILE_BYTES) {
    throw new Error(
      `download is ${declared} bytes; the limit is ${MAX_SLACK_FILE_BYTES}`,
    );
  }
  const partial = `${destination}.partial-${createHash("sha256")
    .update(destination + Date.now())
    .digest("hex")
    .slice(0, 12)}`;
  const handle = await open(partial, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    if (!response.body) throw new Error("file download returned no body");
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > MAX_SLACK_FILE_BYTES) {
        throw new Error(
          `download exceeded the ${MAX_SLACK_FILE_BYTES}-byte limit`,
        );
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    if (expectedSize !== null && size !== expectedSize) {
      throw new Error(
        `download size ${size} does not match the declared ${expectedSize}`,
      );
    }
    await handle.close();
    await rename(partial, destination);
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(partial).catch(() => {});
    throw error;
  }
}

export async function writeAll(
  writer: SlackFileWriter,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
      throw new Error("file write made no valid progress");
    }
    offset += bytesWritten;
  }
}
