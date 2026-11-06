import { GoogleProductivityError } from "./errors.js";
import {
  DRIVE_EXPORT_LIMIT_BYTES,
  type GooglePage,
  type GoogleTransport,
} from "./http.js";

export const DRIVE_SCOPES = {
  read: "https://www.googleapis.com/auth/drive.readonly",
  write: "https://www.googleapis.com/auth/drive.file",
} as const;

/** drive/v3 `File`, the fields the commands return. */
export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  /** Bytes, as a decimal string; absent for Google-native files. */
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
}

const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink";

/** Above this, `drive upload` switches from a multipart to a resumable upload. */
export const MULTIPART_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

/** The most `drive download` and `mail fetch_attachment` bring into the session. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export interface NativeExport {
  /** The Google-native type (`application/vnd.google-apps.*`). */
  nativeType: string;
  kind: "document" | "spreadsheet" | "presentation";
  /** What `drive read` exports, as text. */
  read: { mimeType: string };
  /** What `drive download` exports, as a file. */
  download: { mimeType: string; extension: string };
}

/**
 * Google-native files have no bytes of their own, so `drive read` and
 * `drive download` export them (docs/productivity/google.md, Results). Each
 * export is limited to `DRIVE_EXPORT_LIMIT_BYTES`; a larger file reports that
 * limit (`export_too_large`) rather than arriving cut short.
 */
export const NATIVE_EXPORTS: readonly NativeExport[] = [
  {
    nativeType: "application/vnd.google-apps.document",
    kind: "document",
    read: { mimeType: "text/plain" },
    download: {
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx",
    },
  },
  {
    nativeType: "application/vnd.google-apps.spreadsheet",
    kind: "spreadsheet",
    // Drive's CSV export carries the first sheet only.
    read: { mimeType: "text/csv" },
    download: {
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
    },
  },
  {
    nativeType: "application/vnd.google-apps.presentation",
    kind: "presentation",
    read: { mimeType: "text/plain" },
    download: {
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
    },
  },
];

export function nativeExport(
  mimeType: string | undefined,
): NativeExport | undefined {
  return NATIVE_EXPORTS.find((entry) => entry.nativeType === mimeType);
}

export function isGoogleNative(mimeType: string | undefined): boolean {
  return mimeType?.startsWith("application/vnd.google-apps.") ?? false;
}

/** Whether a stored file's bytes are text `drive read` can return. */
export function isTextType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith("text/") ||
    /^application\/(json|xml|csv|x-yaml|yaml|javascript|x-sh|sql)(;|$)/.test(
      mimeType,
    ) ||
    /\+(json|xml)(;|$)/.test(mimeType)
  );
}

/** A value inside a Drive query string literal. */
export function driveQueryLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The `q` for `files.list` from the neutral `drive search` arguments. */
export function driveSearchQuery(options: {
  query?: string;
  folderId?: string;
  modifiedAfter?: string;
}): string {
  const clauses = ["trashed = false"];
  if (options.query?.trim()) {
    clauses.push(
      `fullText contains ${driveQueryLiteral(options.query.trim())}`,
    );
  }
  if (options.folderId)
    clauses.push(`${driveQueryLiteral(options.folderId)} in parents`);
  if (options.modifiedAfter) {
    clauses.push(`modifiedTime > ${driveQueryLiteral(options.modifiedAfter)}`);
  }
  return clauses.join(" and ");
}

/** The Drive REST API (`drive/v3`, `upload/drive/v3`). */
export class DriveClient {
  constructor(private readonly transport: GoogleTransport) {}

  async listFiles(
    options: { q: string; pageSize?: number; pageToken?: string },
    signal?: AbortSignal,
  ): Promise<GooglePage<DriveFile>> {
    const body = await this.transport.json<{
      files?: DriveFile[];
      nextPageToken?: string;
    }>(`${this.transport.endpoints.drive}/files`, {
      query: {
        q: options.q,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      },
      scope: DRIVE_SCOPES.read,
      signal,
    });
    return { items: body.files ?? [], nextPageToken: body.nextPageToken };
  }

  getFile(id: string, signal?: AbortSignal): Promise<DriveFile> {
    return this.transport.json<DriveFile>(
      `${this.transport.endpoints.drive}/files/${encodeURIComponent(id)}`,
      {
        query: { fields: FILE_FIELDS },
        scope: DRIVE_SCOPES.read,
        signal,
      },
    );
  }

  /** `files.export`: a Google-native file in `mimeType`, refused above Google's limit. */
  exportFile(
    id: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.transport
      .bytes(
        `${this.transport.endpoints.drive}/files/${encodeURIComponent(id)}/export`,
        {
          query: { mimeType },
          scope: DRIVE_SCOPES.read,
          limitBytes: DRIVE_EXPORT_LIMIT_BYTES,
          signal,
        },
      )
      .catch((error: unknown) => {
        if (
          error instanceof GoogleProductivityError &&
          error.code === "too_large"
        ) {
          throw new GoogleProductivityError(
            "export_too_large",
            `The file is larger than Google's export limit of ${DRIVE_EXPORT_LIMIT_BYTES / (1024 * 1024)} MB, so it cannot be exported.`,
            { limitBytes: DRIVE_EXPORT_LIMIT_BYTES },
          );
        }
        throw error;
      });
  }

  /** `files.get?alt=media`: a stored file's bytes. */
  downloadFile(
    id: string,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.transport.bytes(
      `${this.transport.endpoints.drive}/files/${encodeURIComponent(id)}`,
      {
        query: { alt: "media" },
        scope: DRIVE_SCOPES.read,
        limitBytes,
        signal,
      },
    );
  }

  /**
   * `files.create` with content: a multipart upload, or a resumable one above
   * `MULTIPART_UPLOAD_LIMIT_BYTES`. Neither is retried.
   */
  uploadFile(
    file: {
      name: string;
      mimeType: string;
      parents?: string[];
      data: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const metadata = {
      name: file.name,
      ...(file.parents?.length ? { parents: file.parents } : {}),
    };
    return file.data.byteLength > MULTIPART_UPLOAD_LIMIT_BYTES
      ? this.resumableUpload(metadata, file, signal)
      : this.multipartUpload(metadata, file, signal);
  }

  private multipartUpload(
    metadata: Record<string, unknown>,
    file: { mimeType: string; data: Uint8Array },
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const boundary = `introspection-${crypto.randomUUID()}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    return this.transport.json<DriveFile>(
      `${this.transport.endpoints.driveUpload}/files`,
      {
        method: "POST",
        query: { uploadType: "multipart", fields: FILE_FIELDS },
        body: new Uint8Array(Buffer.concat([head, file.data, tail])),
        contentType: `multipart/related; boundary=${boundary}`,
        write: true,
        scope: DRIVE_SCOPES.write,
        signal,
      },
    );
  }

  private async resumableUpload(
    metadata: Record<string, unknown>,
    file: { mimeType: string; data: Uint8Array },
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const start = await this.transport.send(
      `${this.transport.endpoints.driveUpload}/files`,
      {
        method: "POST",
        query: { uploadType: "resumable", fields: FILE_FIELDS },
        json: metadata,
        write: true,
        scope: DRIVE_SCOPES.write,
        signal,
      },
    );
    const session = start.headers.get("Location");
    // The egress admits only these paths on www.googleapis.com, and the
    // session URI must not send the bytes anywhere else.
    if (
      !session ||
      !session.startsWith(`${this.transport.endpoints.driveUpload}/`)
    ) {
      throw new GoogleProductivityError(
        "provider_error",
        "Drive did not return an upload session on the upload host.",
      );
    }
    return this.transport.json<DriveFile>(session, {
      method: "PUT",
      body: file.data,
      contentType: file.mimeType,
      write: true,
      scope: DRIVE_SCOPES.write,
      signal,
    });
  }
}
