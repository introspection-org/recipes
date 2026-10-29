import { createCallResult } from "mcporter";

/** How a `tools[server][tool]` call decodes its result; the call itself is `json`. */
export type McpRunResultFormat =
  | "json"
  | "text"
  | "markdown"
  | "images"
  | "content"
  | "structuredContent"
  | "raw";

/** One MCP tool as a script calls it: `tools["server"]["tool"](args)`. */
export interface McpRunToolFunction {
  (args?: Record<string, unknown>): Promise<unknown>;
  text(args?: Record<string, unknown>): Promise<unknown>;
  markdown(args?: Record<string, unknown>): Promise<unknown>;
  images(args?: Record<string, unknown>): Promise<unknown>;
  content(args?: Record<string, unknown>): Promise<unknown>;
  structuredContent(args?: Record<string, unknown>): Promise<unknown>;
  raw(args?: Record<string, unknown>): Promise<unknown>;
}

/** A server's tools by name, and the session's servers by id. */
export type McpRunTools = Readonly<Record<string, Readonly<Record<string, McpRunToolFunction>>>>;

export class McpRunUsageError extends Error {}

export interface McpRunRemoteErrorDetails extends Record<string, unknown> {
  code?: string;
  message: string;
  retryable?: boolean;
  action?: string;
  outcome?: string;
}

export class McpRemoteToolResultError extends Error {
  constructor(readonly details: McpRunRemoteErrorDetails) {
    super(details.message);
    this.name = "McpRemoteToolResultError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function checkedCallResult(
  callResult: ReturnType<typeof createCallResult>
): ReturnType<typeof createCallResult> {
  if (asRecord(callResult.raw).isError === true) {
    // Fail loudly in code mode so a bad call rejects instead of flowing an
    // error string into downstream logic.
    const parsed = callResult.json();
    const parsedRecord = asRecord(parsed);
    const parsedError = Object.prototype.hasOwnProperty.call(parsedRecord, "error")
      ? parsedRecord.error
      : parsedRecord;
    const errorObject = asRecord(parsedError);
    const message =
      typeof parsedError === "string"
        ? parsedError
        : typeof errorObject.message === "string"
          ? errorObject.message
          : callResult.text() ?? "MCP tool call failed.";
    throw new McpRemoteToolResultError({ ...errorObject, message });
  }
  return callResult;
}

export function decodeCallResult(
  callResult: ReturnType<typeof createCallResult>,
  format: McpRunResultFormat,
  ref: string
): unknown {
  switch (format) {
    case "json": {
      const decoded = callResult.json();
      if (decoded === null && callResult.structuredContent() == null && callResult.text() != null) {
        // The text is usually the reason (not connected, an upstream error), so
        // it travels with the error instead of being hidden behind a format hint.
        const text = callResult.text()!.trim();
        const shown = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        throw new McpRunUsageError(
          `${ref} returned text, not JSON: ${shown} ` +
            `If plain text is this tool's documented response, call tools[${JSON.stringify(ref.split(".")[0])}]` +
            `[${JSON.stringify(ref.slice(ref.indexOf(".") + 1))}].text(args).`
        );
      }
      return decoded;
    }
    case "text":
      return callResult.text();
    case "markdown":
      return callResult.markdown();
    case "images":
      return callResult.images();
    case "content":
      return callResult.content();
    case "structuredContent":
      return callResult.structuredContent();
    case "raw":
      return callResult.raw;
  }
}
