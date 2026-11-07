import type {
  Attributes,
  Span,
  SpanOptions,
  SpanStatus,
  Tracer,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  createProductivityHttp,
  MAX_RECORDED_BODY_BYTES,
  OPERATION_ID_ATTRIBUTE,
  RESPONSE_BODY_ATTRIBUTE,
  retryAfterSeconds,
  type ProductivityFetch,
  type ProductivityHttpRequest,
} from "../src/productivity/index.js";

interface Call {
  url: string;
  init: Parameters<ProductivityFetch>[1];
}

function json(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface RecordedSpan {
  name: string;
  attributes: Attributes;
  status?: SpanStatus;
  ended: boolean;
}

function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer = {
    startSpan(name: string, options?: SpanOptions) {
      const recorded: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        ended: false,
      };
      spans.push(recorded);
      const span = {
        setAttribute(key: string, value: Attributes[string]) {
          recorded.attributes[key] = value;
          return span;
        },
        setAttributes(attributes: Attributes) {
          Object.assign(recorded.attributes, attributes);
          return span;
        },
        setStatus(status: SpanStatus) {
          recorded.status = status;
          return span;
        },
        end() {
          recorded.ended = true;
        },
      };
      return span as unknown as Span;
    },
  };
  return { tracer: tracer as unknown as Tracer, spans };
}

/** The host's `http` over answers served in turn, without a request hook unless `hooked`. */
function setup(
  answers: Response[],
  options: { env?: Record<string, string>; hooked?: boolean } = {},
) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const { tracer, spans } = recordingTracer();
  const fetchImpl: ProductivityFetch = async (url, init) => {
    calls.push({ url, init });
    return answers.shift() ?? json({}, 500);
  };
  const realFetch = globalThis.fetch;
  const http = createProductivityHttp({
    provider: "example",
    env: options.env ?? { INTROSPECTION_TASK_ID: "task-1" },
    ...(options.hooked ? { fetch: fetchImpl } : {}),
    sleep: async (ms) => {
      waits.push(ms);
    },
    tracer,
  });
  const send = async (request: Partial<ProductivityHttpRequest> = {}) => {
    if (!options.hooked) globalThis.fetch = fetchImpl as typeof fetch;
    try {
      return await http({
        method: "GET",
        url: "https://api.example.com/v1/items/42?q=secret",
        template: "/v1/items/{id}",
        operation: "items.get",
        read: true,
        ...request,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  return { send, calls, waits, spans };
}

const authorization = (call: Call) =>
  (call.init.headers as Record<string, string>).Authorization;

describe("productivity http: the credential", () => {
  it("sends the egress placeholder behind the native egress proxy, refusing a redirect", async () => {
    const { send, calls } = setup([json({})]);
    await send();
    expect(authorization(calls[0]!)).toBe("Bearer introspection-egress");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("sends the placeholder whatever the environment when a host's hook attaches the credential", async () => {
    const { send, calls } = setup([json({})], { env: {}, hooked: true });
    await send();
    expect(authorization(calls[0]!)).toBe("Bearer introspection-egress");
  });

  it("sends the session locator to the provider listener, keeping the provider's URL", async () => {
    const { send, calls } = setup([json({})], {
      env: {
        INTROSPECTION_TOKEN: "locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
      },
    });
    await send();
    expect(authorization(calls[0]!)).toBe("Bearer locator");
    expect(calls[0]!.url).toBe("https://api.example.com/v1/items/42?q=secret");
  });

  it("refuses to send outside the egress environment", async () => {
    const { send, calls } = setup([json({})], { env: {} });
    await expect(send()).rejects.toThrow(/Introspection cloud egress/);
    expect(calls).toHaveLength(0);
  });

  it("adds no credential to a pre-authenticated URL", async () => {
    const { send, calls } = setup([json({})]);
    await send({ anonymous: true, headers: { Range: "bytes=0-1" } });
    expect(calls[0]!.init.headers).toEqual({ Range: "bytes=0-1" });
  });
});

describe("productivity http: retries", () => {
  it("retries a throttled read after Retry-After, then answers", async () => {
    const { send, calls, waits } = setup([
      json({}, 429, { "Retry-After": "2" }),
      json({ id: 42 }),
    ]);
    const response = await send();
    expect(await response.json()).toEqual({ id: 42 });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it("backs off 1, 2 and 4 seconds on a 5xx, then hands back the failure with its body and Retry-After", async () => {
    const { send, calls, waits } = setup([
      json({}, 503),
      json({}, 500),
      json({}, 502),
      json({ error: "down" }, 504, { "Retry-After": "7" }),
    ]);
    const response = await send();
    expect(response.status).toBe(504);
    expect(response.retryAfterSeconds).toBe(7);
    expect(await response.json()).toEqual({ error: "down" });
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("hands back, rather than sleeps through, a wait above 30 seconds", async () => {
    const { send, waits } = setup([json({}, 429, { "Retry-After": "3600" })]);
    const response = await send();
    expect(response).toMatchObject({ status: 429, retryAfterSeconds: 3600 });
    expect(waits).toEqual([]);
  });

  it("retries what the provider says is throttled, and nothing else it refuses", async () => {
    const throttled = setup([
      json({ reason: "rateLimitExceeded" }, 403),
      json({}),
    ]);
    const answer = await throttled.send({
      throttled: (status, body) =>
        status === 403 && body.includes("rateLimitExceeded"),
    });
    expect(answer.ok).toBe(true);
    expect(throttled.waits).toEqual([1000]);

    const refused = setup([json({ reason: "forbidden" }, 403), json({})]);
    expect((await refused.send()).status).toBe(403);
    expect(refused.calls).toHaveLength(1);
  });

  it("sends a write once, on a rate limit or a 5xx", async () => {
    for (const status of [429, 503]) {
      const { send, calls } = setup([json({}, status), json({})]);
      expect((await send({ method: "POST", read: false })).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-11-07T10:00:00Z");
    expect(retryAfterSeconds("3", now)).toBe(3);
    expect(retryAfterSeconds("Sat, 07 Nov 2026 10:00:30 GMT", now)).toBe(30);
    expect(retryAfterSeconds("soon", now)).toBeUndefined();
    expect(retryAfterSeconds(undefined, now)).toBeUndefined();
  });
});

describe("productivity http: spans", () => {
  it("records each attempt as a client span named after the template, with a JSON body and no path, query or header", async () => {
    const { send, spans } = setup([json({}, 429), json({ id: 42 })]);
    await send();
    expect(spans.map((span) => [span.name, span.ended])).toEqual([
      ["GET /v1/items/{id}", true],
      ["GET /v1/items/{id}", true],
    ]);
    expect(spans[1]!.attributes).toEqual({
      "http.request.method": "GET",
      "server.address": "api.example.com",
      "server.port": 443,
      "url.template": "/v1/items/{id}",
      [OPERATION_ID_ATTRIBUTE]: "items.get",
      "http.response.status_code": 200,
      "http.response.body.size": 9,
      [RESPONSE_BODY_ATTRIBUTE]: '{"id":42}',
    });
    expect(spans[0]!.attributes["error.type"]).toBe("429");
    expect(spans[0]!.status?.code).toBe(2);
    const recorded = JSON.stringify(spans);
    expect(recorded).not.toContain("secret");
    expect(recorded).not.toContain("introspection-egress");
  });

  it("records a large JSON body's size only, and bytes never", async () => {
    const large = "x".repeat(MAX_RECORDED_BODY_BYTES);
    const { send, spans } = setup([
      json({ large }),
      new Response(new Uint8Array([80, 75]), {
        headers: { "Content-Type": "application/zip" },
      }),
    ]);
    await send();
    const bytes = await send();
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(
      new Uint8Array([80, 75]),
    );
    expect(spans[0]!.attributes[RESPONSE_BODY_ATTRIBUTE]).toBeUndefined();
    expect(spans[0]!.attributes["http.response.body.size"]).toBe(
      MAX_RECORDED_BODY_BYTES + 12,
    );
    expect(spans[1]!.attributes).not.toHaveProperty("http.response.body.size");
    expect(spans[1]!.attributes[RESPONSE_BODY_ATTRIBUTE]).toBeUndefined();
  });

  it("records a request that never got an answer", async () => {
    const { tracer, spans } = recordingTracer();
    const http = createProductivityHttp({
      provider: "example",
      env: {},
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      tracer,
    });
    await expect(
      http({ method: "GET", url: "https://api.example.com/v1/items" }),
    ).rejects.toThrow("fetch failed");
    expect(spans[0]).toMatchObject({
      attributes: { "error.type": "TypeError" },
      status: { code: 2 },
      ended: true,
    });
  });
});
