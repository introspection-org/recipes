import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import FetchAdapter from "@pollyjs/adapter-fetch";
import { Polly } from "@pollyjs/core";
import FSPersister from "@pollyjs/persister-fs";

// Both are CommonJS; under NodeNext their default import types as the module,
// though at run time it is the class `register` takes.
type Registrable = Parameters<typeof Polly.register>[0];
Polly.register(FetchAdapter as unknown as Registrable);
Polly.register(FSPersister as unknown as Registrable);

/**
 * `record` talks to the live MCP server with the token in
 * `MCP_RECORD_TOKEN_FILE`; anything else replays the committed cassette, so
 * CI needs no credential.
 */
export const RECORDING = process.env.POLLY_MODE === "record";

// The same redaction the JS SDK applies to its cassettes
// (introspection-js-sdk `tests/polly-setup.ts`), plus email addresses, since
// an MCP server's answers name the people in the workspace.
const SENSITIVE_HEADER =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|\btoken\b|secret|password|credential|cookie|session)/i;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    "REDACTED_JWT",
  ],
  [/lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, "REDACTED_LINEAR_TOKEN"],
  [/tvly-[A-Za-z0-9_-]{20,}/g, "REDACTED_TAVILY_KEY"],
  [
    /("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]+(")/g,
    "$1REDACTED_SECRET$2",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "person@example.com"],
];

function scrub(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

// Fields whose values are a workspace's own words: replaced with an example of
// the same type, so a cassette keeps every payload's shape and none of its
// content. `name` under a state or status is kept: it is a workflow word, and
// the adapter reads it.
const FREE_TEXT = new Set([
  "title",
  "description",
  "body",
  "name",
  "displayName",
  "url",
  "gitBranchName",
  "summary",
  "key",
  "slug",
  "avatarUrl",
  "color",
  // Linear's MCP server flattens these to plain strings.
  "assignee",
  "createdBy",
  "creator",
  "delegate",
  "team",
  "project",
  "labels",
  "cycle",
  "milestone",
]);
const KEEP_NAME_UNDER = new Set(["state", "status", "priority"]);

/**
 * Replaces a recording's content with examples of the same shape. Issue keys
 * and UUIDs map consistently within one recording, in requests and responses
 * alike, so a replayed request names what the replayed response named.
 */
class Anonymizer {
  private readonly keys = new Map<string, string>();
  private readonly uuids = new Map<string, string>();

  text(value: string): string {
    return scrub(value)
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        (uuid) => {
          if (!this.uuids.has(uuid))
            this.uuids.set(
              uuid,
              `00000000-0000-4000-8000-${String(this.uuids.size + 1).padStart(12, "0")}`,
            );
          return this.uuids.get(uuid)!;
        },
      )
      .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, (key) => {
        if (!this.keys.has(key))
          this.keys.set(key, `ENG-${this.keys.size + 1}`);
        return this.keys.get(key)!;
      });
  }

  value(value: unknown, key?: string, parent?: string): unknown {
    if (typeof value === "string") {
      if (
        key &&
        FREE_TEXT.has(key) &&
        !(key === "name" && parent && KEEP_NAME_UNDER.has(parent))
      )
        return key === "url" || key === "avatarUrl"
          ? "https://example.com/example"
          : `Example ${key}`;
      return this.text(value);
    }
    if (Array.isArray(value))
      return value.map((item) => this.value(item, key, parent));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field,
          this.value(item, field, key),
        ]),
      );
    return value;
  }

  /** One JSON-RPC message: its arguments, its structured result, and any JSON text content. */
  message(message: unknown): unknown {
    const rpc = message as {
      params?: { arguments?: unknown };
      result?: {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
      };
    };
    if (rpc.params?.arguments !== undefined)
      rpc.params.arguments = this.value(rpc.params.arguments);
    if (rpc.result?.structuredContent !== undefined)
      rpc.result.structuredContent = this.value(rpc.result.structuredContent);
    for (const part of rpc.result?.content ?? []) {
      if (part.type !== "text" || part.text === undefined) continue;
      try {
        part.text = JSON.stringify(this.value(JSON.parse(part.text)));
      } catch {
        part.text = "Example text.";
      }
    }
    return message;
  }

  /** A request or response body: JSON, or an event stream of `data:` lines. */
  body(text: string): string {
    const one = (json: string) => {
      const parsed = JSON.parse(json) as unknown;
      return JSON.stringify(
        Array.isArray(parsed)
          ? parsed.map((item) => this.message(item))
          : this.message(parsed),
      );
    };
    try {
      if (
        !text.trimStart().startsWith("{") &&
        !text.trimStart().startsWith("[")
      )
        return text
          .split("\n")
          .map((line) =>
            line.startsWith("data:")
              ? `data: ${one(line.slice(5).trim())}`
              : line,
          )
          .join("\n");
      return one(text);
    } catch {
      return scrub(text);
    }
  }
}

interface Entry {
  request: {
    headers: Array<{ name: string; value: string }>;
    postData?: { text?: string };
  };
  response: {
    headers: Array<{ name: string; value: string }>;
    content?: { text?: string };
  };
}

function redactHeaders(headers: Array<{ name: string; value: string }>) {
  for (const header of headers)
    if (SENSITIVE_HEADER.test(header.name)) header.value = "REDACTED";
}

/** A JSON-RPC body without its per-run `id`, so a replay matches by method and params. */
function rpcKey(body: string): string {
  try {
    const strip = (message: Record<string, unknown>) => {
      const { id: _id, ...rest } = message;
      return rest;
    };
    const parsed = JSON.parse(body) as unknown;
    return JSON.stringify(
      Array.isArray(parsed)
        ? parsed.map((item) => strip(item as Record<string, unknown>))
        : strip(parsed as Record<string, unknown>),
    );
  } catch {
    return body;
  }
}

/** Whether `name` has a cassette under `dir` (Polly writes `<name>_<hash>/recording.har`). */
export function hasRecording(dir: string, name: string): boolean {
  return (
    existsSync(dir) &&
    readdirSync(dir).some(
      (entry) =>
        entry.startsWith(`${name}_`) &&
        existsSync(join(dir, entry, "recording.har")),
    )
  );
}

/**
 * A Polly instance over `fetch` for calls to `host`; every other request
 * passes through. Cassettes go under `dir`, scrubbed before they are written.
 */
export function startMcpRecording(
  name: string,
  dir: string,
  host: string,
): { polly: Polly; calls: string[] } {
  const polly = new Polly(name, {
    mode: RECORDING ? "record" : "replay",
    adapters: ["fetch"],
    adapterOptions: { fetch: { context: globalThis } },
    persister: "fs",
    persisterOptions: { fs: { recordingsDir: dir } },
    recordIfMissing: false,
    recordFailedRequests: true,
    flushRequestsOnStop: true,
    matchRequestsBy: {
      headers: false,
      order: true,
      body: (body: string) => rpcKey(body),
    },
  });
  polly.server
    .any()
    .filter((request) => new URL(request.url).host !== host)
    .passthrough();
  // Each JSON-RPC call to the server, in order: `initialize`, `tools/list`,
  // `tools/call <tool>`.
  const calls: string[] = [];
  polly.server.any().on("request", (request) => {
    if (new URL(request.url).host !== host || !request.body) return;
    const rpc = JSON.parse(String(request.body)) as {
      method?: string;
      params?: { name?: string };
    };
    calls.push(
      rpc.method === "tools/call"
        ? `tools/call ${rpc.params?.name}`
        : (rpc.method ?? "?"),
    );
  });
  const anonymizer = new Anonymizer();
  polly.server.any().on("beforePersist", (_request, recording: Entry) => {
    redactHeaders(recording.request.headers);
    redactHeaders(recording.response.headers);
    if (recording.request.postData?.text)
      recording.request.postData.text = anonymizer.body(
        recording.request.postData.text,
      );
    if (recording.response.content?.text)
      recording.response.content.text = anonymizer.body(
        recording.response.content.text,
      );
  });
  return { polly, calls };
}

/** The bearer token a recording sends: the live one, or a placeholder a replay never sends anywhere. */
export function recordingToken(): string {
  if (!RECORDING) return "replay";
  const file = process.env.MCP_RECORD_TOKEN_FILE;
  if (!file) throw new Error("POLLY_MODE=record needs MCP_RECORD_TOKEN_FILE");
  const answer = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  const token = [answer.access_token, answer.token].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!token) throw new Error(`${file} holds no access_token`);
  return token;
}
