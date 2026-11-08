import type { Tracer } from "@opentelemetry/api";
import {
  createProductivityHttp,
  type ProductivityFetch,
  type ProductivityHttp,
} from "@introspection-ai/recipes/productivity";

type GoogleFetch = ProductivityFetch;
type GoogleRequestInit = Parameters<ProductivityFetch>[1] & {
  headers: Record<string, string>;
};

export interface RecordedCall {
  method: string;
  url: URL;
  init: GoogleRequestInit;
}

export type FakeHandler = (call: RecordedCall) => Response | Promise<Response>;

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Google's error envelope (`{error: {code, message, errors: [{reason}]}}`). */
export function googleError(
  status: number,
  reason: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        code: status,
        message: reason,
        errors: [{ domain: "global", reason, message: reason }],
      },
    },
    status,
    headers,
  );
}

/**
 * A fake Google: each request goes to the first route whose method and path
 * match, in order; a route answering a list of responses serves them in turn.
 */
export function fakeGoogle(
  routes: Array<[string, RegExp, FakeHandler | Response[]]>,
): { fetchImpl: GoogleFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queues = new Map<number, Response[]>();
  const fetchImpl: GoogleFetch = async (url, init) => {
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: new URL(url),
      init: init as GoogleRequestInit,
    };
    calls.push(call);
    const index = routes.findIndex(
      ([method, path]) =>
        method === call.method && path.test(call.url.pathname),
    );
    if (index < 0) return googleError(404, "notFound");
    const handler = routes[index]![2];
    if (Array.isArray(handler)) {
      if (!queues.has(index)) queues.set(index, [...handler]);
      const next = queues.get(index)!.shift();
      return next ?? googleError(500, "backendError");
    }
    return handler(call);
  };
  return { fetchImpl, calls };
}

export function bodyJson(call: RecordedCall): unknown {
  return JSON.parse(String(call.init.body));
}

/** The host's `http` over a fake `fetch`, with its waits recorded. */
export function fakeHttp(
  fetchImpl: ProductivityFetch,
  options: { waits?: number[]; tracer?: Tracer } = {},
): ProductivityHttp {
  return createProductivityHttp({
    provider: "google",
    env: { INTROSPECTION_TASK_ID: "t" },
    fetch: fetchImpl,
    sleep: async (ms) => {
      options.waits?.push(ms);
    },
    ...(options.tracer ? { tracer: options.tracer } : {}),
  });
}
