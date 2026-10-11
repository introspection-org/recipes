import { describe, expect, it } from "vitest";

import { callToolWithHandshakeRetry } from "../src/mcp/cli/core.js";

type Runtime = Parameters<typeof callToolWithHandshakeRetry>[0];

function runtimeFailing(errors: Error[]) {
  let calls = 0;
  const runtime = {
    async callTool() {
      calls += 1;
      const error = errors.shift();
      if (error) throw error;
      return { content: [{ type: "text", text: "{}" }] };
    },
  } as unknown as Runtime;
  return { runtime, calls: () => calls };
}

const refused = () =>
  new Error("Version negotiation failed: the server answered the probe with HTTP 503");

describe("handshake retry", () => {
  it("retries a refused version probe, which never reached the tool", async () => {
    const { runtime, calls } = runtimeFailing([refused(), refused()]);
    await expect(
      callToolWithHandshakeRetry(runtime, "mail", "find", () => ({ args: {} }))
    ).resolves.toMatchObject({ content: [{ text: "{}" }] });
    expect(calls()).toBe(3);
  });

  it("gives up after two retries", async () => {
    const { runtime, calls } = runtimeFailing([refused(), refused(), refused()]);
    await expect(
      callToolWithHandshakeRetry(runtime, "mail", "find", () => ({ args: {} }))
    ).rejects.toThrow("HTTP 503");
    expect(calls()).toBe(3);
  });

  it("never retries a failure that may follow the call", async () => {
    const { runtime, calls } = runtimeFailing([
      new Error("Error POSTing to endpoint: upstream request timeout"),
    ]);
    await expect(
      callToolWithHandshakeRetry(runtime, "mail", "send", () => ({ args: {} }))
    ).rejects.toThrow("upstream request timeout");
    expect(calls()).toBe(1);
  });

  it("stops at the deadline", async () => {
    const { runtime, calls } = runtimeFailing([refused()]);
    await expect(
      callToolWithHandshakeRetry(runtime, "mail", "find", () => ({ args: {} }), Date.now() + 100)
    ).rejects.toThrow("HTTP 503");
    expect(calls()).toBe(1);
  });
});
