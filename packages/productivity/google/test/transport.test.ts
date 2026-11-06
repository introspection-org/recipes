import { describe, expect, it } from "vitest";

import {
  collectPages,
  GoogleProductivityError,
  GoogleTransport,
  GMAIL_SCOPES,
} from "../src/index.js";
import {
  fakeGoogle,
  googleError,
  json,
  recordingSleep,
} from "./fake-google.js";

const URL_UNDER_TEST = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

function transport(
  responses: Response[],
  env: Record<string, string> = { INTROSPECTION_TASK_ID: "task-1" },
) {
  const fake = fakeGoogle([
    ["GET", /labels$/, responses],
    ["POST", /drafts$/, responses],
  ]);
  const recorded = recordingSleep();
  return {
    ...fake,
    waits: recorded.waits,
    transport: new GoogleTransport({
      env,
      fetchImpl: fake.fetchImpl,
      sleep: recorded.sleep,
    }),
  };
}

async function failure(
  promise: Promise<unknown>,
): Promise<GoogleProductivityError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleProductivityError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("placeholder credential", () => {
  it("sends the egress placeholder behind the native egress proxy, never a real token", async () => {
    const { transport: t, calls } = transport([json({ labels: [] })]);
    await t.json(URL_UNDER_TEST, { scope: GMAIL_SCOPES.read });
    expect(calls[0]!.init.headers.Authorization).toBe(
      "Bearer introspection-egress",
    );
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.url.host).toBe("gmail.googleapis.com");
  });

  it("sends the session locator to the provider listener, keeping Google's URL", async () => {
    const { transport: t, calls } = transport([json({ labels: [] })], {
      INTROSPECTION_TOKEN: "locator",
      INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
    });
    await t.json(URL_UNDER_TEST, { scope: GMAIL_SCOPES.read });
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer locator");
    expect(calls[0]!.url.toString()).toBe(URL_UNDER_TEST);
  });

  it("refuses to run outside the egress environment", async () => {
    const { transport: t, calls } = transport([json({})], {});
    await expect(
      t.json(URL_UNDER_TEST, { scope: GMAIL_SCOPES.read }),
    ).rejects.toThrow(/require the Introspection cloud egress environment/);
    expect(calls).toHaveLength(0);
  });
});

describe("error mapping", () => {
  it("maps 401 to not_connected", async () => {
    const error = await failure(
      transport([googleError(401, "authError")]).transport.json(
        URL_UNDER_TEST,
        {
          scope: GMAIL_SCOPES.read,
        },
      ),
    );
    expect(error.code).toBe("not_connected");
  });

  it("maps 403 insufficientPermissions to missing_scope, naming the scope", async () => {
    const error = await failure(
      transport([googleError(403, "insufficientPermissions")]).transport.json(
        URL_UNDER_TEST,
        {
          scope: GMAIL_SCOPES.compose,
        },
      ),
    );
    expect(error).toMatchObject({
      code: "missing_scope",
      scope: GMAIL_SCOPES.compose,
    });
    expect(error.message).toContain(GMAIL_SCOPES.compose);
  });

  it("maps 404 to not_found and 400 to invalid_request", async () => {
    const t = transport([
      googleError(404, "notFound"),
      googleError(400, "invalidArgument"),
    ]).transport;
    expect((await failure(t.json(URL_UNDER_TEST, { scope: "s" }))).code).toBe(
      "not_found",
    );
    expect((await failure(t.json(URL_UNDER_TEST, { scope: "s" }))).code).toBe(
      "invalid_request",
    );
  });
});

describe("rate limits and retries", () => {
  it("retries a read on 429 after Retry-After, then succeeds", async () => {
    const {
      transport: t,
      calls,
      waits,
    } = transport([
      googleError(429, "rateLimitExceeded", { "Retry-After": "2" }),
      json({ labels: [{ id: "L", name: "x" }] }),
    ]);
    await expect(t.json(URL_UNDER_TEST, { scope: "s" })).resolves.toEqual({
      labels: [{ id: "L", name: "x" }],
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it("retries 403 rateLimitExceeded and userRateLimitExceeded with exponential backoff", async () => {
    const { transport: t, waits } = transport([
      googleError(403, "userRateLimitExceeded"),
      googleError(403, "rateLimitExceeded"),
      json({}),
    ]);
    await t.json(URL_UNDER_TEST, { scope: "s" });
    expect(waits).toEqual([500, 1000]);
  });

  it("gives up after the attempts with rate_limited and the wait", async () => {
    const { transport: t, calls } = transport([
      googleError(429, "rateLimitExceeded"),
      googleError(429, "rateLimitExceeded"),
      googleError(429, "rateLimitExceeded"),
      googleError(429, "rateLimitExceeded", { "Retry-After": "7" }),
    ]);
    const error = await failure(t.json(URL_UNDER_TEST, { scope: "s" }));
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 7000 });
    expect(calls).toHaveLength(4);
  });

  it("reports, rather than sleeps through, a wait above the cap", async () => {
    const { transport: t, waits } = transport([
      googleError(429, "rateLimitExceeded", { "Retry-After": "3600" }),
    ]);
    const error = await failure(t.json(URL_UNDER_TEST, { scope: "s" }));
    expect(error).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 3_600_000,
    });
    expect(waits).toEqual([]);
  });

  it("never retries a write, on a rate limit or a 5xx", async () => {
    const limited = transport([
      googleError(429, "rateLimitExceeded"),
      json({}),
    ]);
    const error = await failure(
      limited.transport.json(URL_UNDER_TEST.replace("labels", "drafts"), {
        method: "POST",
        json: {},
        write: true,
        scope: "s",
      }),
    );
    expect(error.code).toBe("rate_limited");
    expect(limited.calls).toHaveLength(1);

    const failing = transport([googleError(503, "backendError"), json({})]);
    const serverError = await failure(
      failing.transport.json(URL_UNDER_TEST.replace("labels", "drafts"), {
        method: "POST",
        json: {},
        write: true,
        scope: "s",
      }),
    );
    expect(serverError).toMatchObject({ code: "provider_error", status: 503 });
    expect(failing.calls).toHaveLength(1);
  });

  it("retries a read once on a 5xx", async () => {
    const recovered = transport([
      googleError(500, "backendError"),
      json({ ok: 1 }),
    ]);
    await expect(
      recovered.transport.json(URL_UNDER_TEST, { scope: "s" }),
    ).resolves.toEqual({ ok: 1 });

    const down = transport([
      googleError(502, "backendError"),
      googleError(502, "backendError"),
      json({}),
    ]);
    expect(
      (await failure(down.transport.json(URL_UNDER_TEST, { scope: "s" }))).code,
    ).toBe("provider_error");
    expect(down.calls).toHaveLength(2);
  });
});

describe("collectPages", () => {
  const pages: Record<string, { items: number[]; nextPageToken?: string }> = {
    start: { items: [1, 2, 3], nextPageToken: "p2" },
    p2: { items: [4, 5], nextPageToken: "p3" },
    p3: { items: [6] },
  };
  const fetchPage = async (token: string | undefined, size: number) => {
    const page = pages[token ?? "start"]!;
    return {
      items: page.items.slice(0, size),
      nextPageToken:
        page.items.length > size
          ? `${token ?? "start"}+${size}`
          : page.nextPageToken,
    };
  };

  it("follows nextPageToken across pages up to the limit", async () => {
    await expect(collectPages(fetchPage, 10)).resolves.toEqual({
      items: [1, 2, 3, 4, 5, 6],
    });
    await expect(collectPages(fetchPage, 5)).resolves.toEqual({
      items: [1, 2, 3, 4, 5],
      nextPageToken: "p3",
    });
  });

  it("asks a page for only the room left, so the cursor never skips items", async () => {
    const sizes: number[] = [];
    await collectPages(async (token, size) => {
      sizes.push(size);
      return fetchPage(token, size);
    }, 4);
    expect(sizes).toEqual([4, 1]);
  });
});
