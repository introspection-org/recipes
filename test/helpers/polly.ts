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
 * `record` talks to the live service (an MCP server with the token in
 * `MCP_RECORD_TOKEN_FILE`, a model API with its key); anything else replays
 * the committed cassette, so CI needs no credential.
 */
export const RECORDING = process.env.POLLY_MODE === "record";

// The same redaction the JS SDK applies to its cassettes
// (introspection-js-sdk `tests/polly-setup.ts`), plus email addresses, since
// an MCP server's answers name the people in the workspace, and the headers
// that name a model API account (organization, workspace, rate-limit tier)
// or trace back to it (request and edge ids).
const SENSITIVE_HEADER =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|\btoken\b|secret|password|credential|cookie|session|organization|project|workspace|request[-_]?id|ratelimit|cf-ray)/i;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    "REDACTED_JWT",
  ],
  [/lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, "REDACTED_LINEAR_TOKEN"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "REDACTED_ANTHROPIC_KEY"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, "REDACTED_OPENAI_KEY"],
  [/tvly-[A-Za-z0-9_-]{20,}/g, "REDACTED_TAVILY_KEY"],
  [
    /("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]+(")/g,
    "$1REDACTED_SECRET$2",
  ],
  [
    /[A-Za-z0-9._%+-]+@(?!example\.(?:com|test)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "person@example.com",
  ],
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
    url: string;
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
    // The handshake names the client's own version, which a Pi bump changes;
    // what it negotiates is not what a replay checks.
    const strip = (message: Record<string, unknown>) => {
      const { id: _id, ...rest } = message;
      return rest.method === "initialize" ? { method: rest.method } : rest;
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
/** The folder name Polly gives a recording: it writes `.` as `-`. */
function cassetteName(name: string): string {
  return name.replaceAll(".", "-");
}

export function hasRecording(dir: string, name: string): boolean {
  return (
    existsSync(dir) &&
    readdirSync(dir).some(
      (entry) =>
        entry.startsWith(`${cassetteName(name)}_`) &&
        existsSync(join(dir, entry, "recording.har")),
    )
  );
}

/**
 * A Polly instance over `fetch` for calls to `host`; every other request
 * passes through. A replay matches requests in order, and by `body` when it
 * is given. Headers are redacted and bodies rewritten by `rewrite` before a
 * cassette is written.
 */
function startRecording(
  name: string,
  dir: string,
  host: string | readonly string[],
  options: {
    body?: (body: string) => string;
    rewrite: (text: string) => string;
    /** Rewrites each request's URL before it is written, for ids in a path. */
    url?: (url: string) => string;
    record?: boolean;
  },
): Polly {
  const hosts: readonly string[] = typeof host === "string" ? [host] : host;
  const polly = new Polly(name, {
    mode: (options.record ?? RECORDING) ? "record" : "replay",
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
      body: options.body ?? false,
      // A recording's URLs are anonymized: match its paths without their ids.
      ...(options.url
        ? {
            url: {
              pathname: (pathname: string) =>
                pathname.replace(
                  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
                  "{id}",
                ),
            },
          }
        : {}),
    },
  });
  polly.server
    .any()
    .filter((request) => !hosts.includes(new URL(request.url).host))
    .passthrough();
  polly.server.any().on("beforePersist", (_request, recording: Entry) => {
    redactHeaders(recording.request.headers);
    redactHeaders(recording.response.headers);
    if (options.url) recording.request.url = options.url(recording.request.url);
    if (recording.request.postData?.text)
      recording.request.postData.text = options.rewrite(
        recording.request.postData.text,
      );
    if (recording.response.content?.text)
      recording.response.content.text = options.rewrite(
        recording.response.content.text,
      );
  });
  return polly;
}

/**
 * A REST API's recording across `hosts`, matched in order and anonymized: ids
 * map consistently across URLs, request bodies and responses, so a replay's
 * requests name what the replayed responses named.
 */
export function startRestRecording(
  name: string,
  dir: string,
  hosts: readonly string[],
): Polly {
  const anonymizer = new Anonymizer();
  return startRecording(name, dir, hosts, {
    rewrite: (text) => {
      try {
        return JSON.stringify(anonymizer.value(JSON.parse(text)));
      } catch {
        return scrub(text);
      }
    },
    url: (url) => anonymizer.text(url),
  });
}

/** An MCP server's recording, matched by JSON-RPC call and anonymized. */
export function startMcpRecording(
  name: string,
  dir: string,
  host: string,
): { polly: Polly; calls: string[] } {
  const anonymizer = new Anonymizer();
  const polly = startRecording(name, dir, host, {
    body: rpcKey,
    rewrite: (text) => anonymizer.body(text),
  });
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
  return { polly, calls };
}

/**
 * A model API's recording, matched by order alone: a request carries the
 * date and the run's paths, so no two runs send the same body. Bodies are
 * kept, as the evidence of what the model was sent and answered, after the
 * secret scrubber and `replace` (local paths, say) have run over them.
 * `responses` collects each response body from `host`, recorded or replayed,
 * rewritten the same way so a recording and its replay read alike.
 */
/**
 * A streamed tool call's input as one `input_json_delta` per content block:
 * the model splits it at arbitrary points, so a path or address it echoes
 * would otherwise slip past a rewrite in pieces.
 */
function joinToolInputDeltas(text: string): string {
  if (text.includes("response.function_call_arguments.delta"))
    return joinOpenAiArgumentDeltas(text);
  if (!text.includes("input_json_delta")) return text;
  const events = text.split("\n\n");
  const first = new Map<number, { at: number; json: string }>();
  const kept: Array<string | undefined> = events.map((event, at) => {
    const data = event.split("\n").find((line) => line.startsWith("data:"));
    if (!data) return event;
    let parsed: {
      type?: string;
      index?: number;
      delta?: { type?: string; partial_json?: string };
    };
    try {
      parsed = JSON.parse(data.slice(5));
    } catch {
      return event;
    }
    if (
      parsed.type !== "content_block_delta" ||
      parsed.delta?.type !== "input_json_delta" ||
      parsed.index === undefined
    )
      return event;
    const seen = first.get(parsed.index);
    if (seen) {
      seen.json += parsed.delta.partial_json ?? "";
      return undefined;
    }
    first.set(parsed.index, { at, json: parsed.delta.partial_json ?? "" });
    return event;
  });
  for (const [index, { at, json }] of first)
    kept[at] = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json },
    })}`;
  return kept.filter((event) => event !== undefined).join("\n\n");
}

/** The same for OpenAI's Responses stream: one `function_call_arguments.delta` per call. */
function joinOpenAiArgumentDeltas(text: string): string {
  const events = text.split("\n\n");
  const first = new Map<
    string,
    { at: number; event: Record<string, unknown> }
  >();
  const kept: Array<string | undefined> = events.map((event, at) => {
    const data = event.split("\n").find((line) => line.startsWith("data:"));
    if (!data) return event;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.slice(5)) as Record<string, unknown>;
    } catch {
      return event;
    }
    if (parsed.type !== "response.function_call_arguments.delta") return event;
    const key = String(parsed.item_id ?? parsed.output_index);
    const seen = first.get(key);
    if (seen) {
      seen.event.delta = `${String(seen.event.delta ?? "")}${String(parsed.delta ?? "")}`;
      return undefined;
    }
    first.set(key, { at, event: parsed });
    return event;
  });
  for (const { at, event } of first.values())
    kept[at] =
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify(event)}`;
  return kept.filter((event) => event !== undefined).join("\n\n");
}

export function startModelRecording(
  name: string,
  dir: string,
  host: string,
  replace: ReadonlyArray<readonly [string, string]> = [],
  record = RECORDING,
): { polly: Polly; responses: string[] } {
  const rewrite = (text: string) =>
    replace.reduce(
      (out, [from, to]) => out.split(from).join(to),
      scrub(joinToolInputDeltas(text)),
    );
  const polly = startRecording(name, dir, host, { rewrite, record });
  const responses: string[] = [];
  polly.server.any().on("response", (request, response) => {
    if (new URL(request.url).host === host)
      responses.push(rewrite(String(response.body ?? "")));
  });
  return { polly, responses };
}

/** How many requests the cassette for `name` under `dir` holds. */
export function recordedRequests(dir: string, name: string): number {
  const entry = readdirSync(dir).find(
    (item) =>
      item.startsWith(`${cassetteName(name)}_`) &&
      existsSync(join(dir, item, "recording.har")),
  );
  if (!entry) throw new Error(`No recording ${name} under ${dir}`);
  const har = JSON.parse(
    readFileSync(join(dir, entry, "recording.har"), "utf8"),
  ) as { log: { entries: unknown[] } };
  return har.log.entries.length;
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
