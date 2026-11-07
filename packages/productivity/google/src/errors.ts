import type {
  ProductivityErrorCode,
  ProductivityErrorInfo,
  ProductivityProviderError,
} from "@introspection-ai/recipes/productivity";

export interface GoogleErrorDetails {
  /** HTTP status of the provider answer, when there was one. */
  status?: number;
  /** Google's `errors[].reason` (or `ErrorInfo.reason`), when it gave one. */
  reason?: string;
  /** `missing_scope`: the OAuth scope the command needs. */
  scope?: string;
  /** `rate_limited`: how long to wait before trying again. */
  retryAfterMs?: number;
  /** A size limit the request exceeded; the content is refused, never cut. */
  limitBytes?: number;
}

/**
 * A failed Google call, mapped to the shared productivity error
 * (docs/productivity/google.md, Errors). The host reads `productivity`.
 */
export class GoogleProductivityError
  extends Error
  implements ProductivityProviderError
{
  readonly code: ProductivityErrorCode;
  readonly status?: number;
  readonly reason?: string;
  readonly scope?: string;
  readonly retryAfterMs?: number;
  readonly limitBytes?: number;

  constructor(
    code: ProductivityErrorCode,
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

  get productivity(): ProductivityErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.scope ? { scope: this.scope } : {}),
      ...(this.retryAfterMs !== undefined
        ? { retry_after_seconds: Math.ceil(this.retryAfterMs / 1000) }
        : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}

/** Whether `error` reports a size limit (an export or a download too large). */
export function isSizeLimit(error: unknown): error is GoogleProductivityError {
  return (
    error instanceof GoogleProductivityError && error.limitBytes !== undefined
  );
}
