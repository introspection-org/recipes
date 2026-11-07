import { describe, expect, it } from "vitest";

import {
  collectPages,
  GoogleProductivityError,
  GoogleTransport,
  GMAIL_SCOPES,
} from "../src/index.js";
import { fakeGoogle, fakeHttp, googleError, json } from "./fake-google.js";

const URL_UNDER_TEST = "https://gmail.googleapis.com/gmail/v1/users/me/labels";
const LABELS = {
  operation: "gmail.users.labels.list",
  template: "/gmail/v1/users/{userId}/labels",
};

function transport(responses: Response[]) {
  const fake = fakeGoogle([
    ["GET", /labels$/, responses],
    ["POST", /drafts$/, responses],
  ]);
  const waits: number[] = [];
  return {
    ...fake,
    waits,
    transport: new GoogleTransport(fakeHttp(fake.fetchImpl, { waits })),
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

describe("error mapping", () => {
  it("maps 401 to not_connected", async () => {
    const error = await failure(
      transport([googleError(401, "authError")]).transport.json(
        URL_UNDER_TEST,
        {
          ...LABELS,
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
          ...LABELS,
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
    expect(
      (await failure(t.json(URL_UNDER_TEST, { ...LABELS, scope: "s" }))).code,
    ).toBe("not_found");
    expect(
      (await failure(t.json(URL_UNDER_TEST, { ...LABELS, scope: "s" }))).code,
    ).toBe("invalid_request");
  });
});

describe("rate limits", () => {
  it("retries a read on 403 rateLimitExceeded and userRateLimitExceeded, which the host does not know", async () => {
    const { transport: t, waits } = transport([
      googleError(403, "userRateLimitExceeded"),
      googleError(403, "rateLimitExceeded"),
      json({}),
    ]);
    await t.json(URL_UNDER_TEST, { ...LABELS, scope: "s" });
    expect(waits).toEqual([1000, 2000]);
  });

  it("maps a rate limit the host stopped retrying to rate_limited, with the wait", async () => {
    const { transport: t, waits } = transport([
      googleError(429, "rateLimitExceeded", { "Retry-After": "3600" }),
    ]);
    const error = await failure(
      t.json(URL_UNDER_TEST, { ...LABELS, scope: "s" }),
    );
    expect(error).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 3_600_000,
    });
    expect(waits).toEqual([]);
  });

  it("sends a write once, mapping its rate limit or 5xx", async () => {
    const limited = transport([googleError(429, "rateLimitExceeded")]);
    const write = {
      method: "POST" as const,
      json: {},
      write: true,
      ...LABELS,
      scope: "s",
    };
    const drafts = URL_UNDER_TEST.replace("labels", "drafts");
    expect((await failure(limited.transport.json(drafts, write))).code).toBe(
      "rate_limited",
    );
    expect(limited.calls).toHaveLength(1);

    const failing = transport([googleError(503, "backendError")]);
    expect(await failure(failing.transport.json(drafts, write))).toMatchObject({
      code: "provider_error",
      status: 503,
    });
    expect(failing.calls).toHaveLength(1);
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
