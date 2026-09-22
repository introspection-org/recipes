import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  mcpDaemonRequestContext,
  mcpTraceContextFromEnv,
} from "../src/mcp/trace-context.js";

describe("MCP daemon trace context", () => {
  it("captures only the current invocation's W3C carrier", () => {
    expect(
      mcpTraceContextFromEnv({
        TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
        TRACESTATE: "vendor=value",
      }),
    ).toEqual({
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "vendor=value",
    });
    expect(mcpTraceContextFromEnv({})).toBeUndefined();
  });

  it("reconstructs a different remote parent for each daemon request", () => {
    const first = mcpDaemonRequestContext({
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    });
    const second = mcpDaemonRequestContext({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
    });

    expect(trace.getSpanContext(first)).toMatchObject({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
      isRemote: true,
    });
    expect(trace.getSpanContext(second)).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: 0,
      isRemote: true,
    });
    expect(trace.getSpanContext(context.active())).toBeUndefined();
  });

  it("ignores malformed and forbidden trace parents", () => {
    const base = context.active();
    expect(
      mcpDaemonRequestContext({ traceparent: "not-a-traceparent" }, base),
    ).toBe(base);
    expect(
      mcpDaemonRequestContext(
        {
          traceparent:
            "ff-11111111111111111111111111111111-2222222222222222-01",
        },
        base,
      ),
    ).toBe(base);
  });
});
