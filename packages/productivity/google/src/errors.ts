/**
 * The command-level failures a Google call maps to (docs/productivity/google.md,
 * Errors). The host turns each into a tool result; `not_found` also drops the
 * handle the command was given.
 */
export type GoogleErrorCode =
  | "not_connected"
  | "missing_scope"
  | "rate_limited"
  | "not_found"
  | "export_too_large"
  | "too_large"
  | "invalid_request"
  | "unsupported"
  | "provider_error";

export interface GoogleErrorDetails {
  /** HTTP status of the provider answer, when there was one. */
  status?: number;
  /** Google's `errors[].reason` (or `ErrorInfo.reason`), when it gave one. */
  reason?: string;
  /** `missing_scope`: the OAuth scope the command needs. */
  scope?: string;
  /** `rate_limited`: how long to wait before trying again. */
  retryAfterMs?: number;
  /** `export_too_large` and `too_large`: the limit that was exceeded. */
  limitBytes?: number;
}

export class GoogleProductivityError extends Error {
  readonly code: GoogleErrorCode;
  readonly status?: number;
  readonly reason?: string;
  readonly scope?: string;
  readonly retryAfterMs?: number;
  readonly limitBytes?: number;

  constructor(
    code: GoogleErrorCode,
    message: string,
    details: GoogleErrorDetails = {},
  ) {
    super(message);
    this.name = "GoogleProductivityError";
    this.code = code;
    this.status = details.status;
    this.reason = details.reason;
    this.scope = details.scope;
    this.retryAfterMs = details.retryAfterMs;
    this.limitBytes = details.limitBytes;
  }
}
