import {
  PRODUCTIVITY_COMMAND_EFFECTS,
  PRODUCTIVITY_COMMANDS,
  PRODUCTIVITY_MODULE_API_VERSION,
  PRODUCTIVITY_SESSION_METHODS,
  PRODUCTIVITY_TOOLS,
  productivityCapabilitiesProblem,
  productivityCommandsFor,
} from "@introspection-ai/recipes/productivity";
import { describe, expect, it } from "vitest";

import googleProductivityModule, {
  createGoogleProductivitySession,
  EXPECTED_MCP_TOOLS,
  GoogleProductivityError,
} from "../src/index.js";
import { fakeGoogle } from "./fake-google.js";

describe("the Google productivity module", () => {
  it("is a descriptor the host accepts, on the host's contract version", () => {
    expect(googleProductivityModule).toMatchObject({
      kind: "productivity",
      provider: "google",
      apiVersion: PRODUCTIVITY_MODULE_API_VERSION,
    });
    expect(
      productivityCapabilitiesProblem(googleProductivityModule.capabilities),
    ).toBeUndefined();
  });

  it("supports every command, each with the host's fixed effect", () => {
    for (const tool of PRODUCTIVITY_TOOLS) {
      expect(
        productivityCommandsFor(googleProductivityModule.capabilities, tool),
      ).toEqual([...PRODUCTIVITY_COMMANDS[tool]]);
      const commands = googleProductivityModule.capabilities[tool]!
        .commands as Record<string, { effect: string }>;
      for (const [command, capability] of Object.entries(commands)) {
        expect(capability.effect, `${tool} ${command}`).toBe(
          (PRODUCTIVITY_COMMAND_EFFECTS[tool] as Record<string, string>)[
            command
          ],
        );
      }
    }
  });

  it("declares MCP exactly for the commands with an expected MCP tool", () => {
    for (const tool of PRODUCTIVITY_TOOLS) {
      const commands = googleProductivityModule.capabilities[tool]!
        .commands as Record<string, { backend: string }>;
      for (const [command, capability] of Object.entries(commands)) {
        expect(capability.backend, `${tool} ${command}`).toBe(
          `${tool}.${command}` in EXPECTED_MCP_TOOLS ? "mcp" : "rest",
        );
      }
    }
    expect(
      googleProductivityModule.capabilities.mail!.commands.send!.backend,
    ).toBe("rest");
  });

  it("opens a session with a method for every declared command", async () => {
    const session = await createGoogleProductivitySession({
      config: { provider: "google", tools: {} },
      env: { INTROSPECTION_TASK_ID: "t" },
      cwd: process.cwd(),
      fetch: fakeGoogle([]).fetchImpl,
    });
    expect(session.provider).toBe("google");
    for (const tool of PRODUCTIVITY_TOOLS) {
      for (const method of Object.values(PRODUCTIVITY_SESSION_METHODS[tool])) {
        expect(
          typeof (session[tool] as Record<string, unknown>)[method],
          `${tool}.${method}`,
        ).toBe("function");
      }
    }
  });

  it("reports errors in the host's shape", () => {
    const error = new GoogleProductivityError("rate_limited", "wait", {
      status: 429,
      retryAfterMs: 1500,
    });
    expect(error.productivity).toEqual({
      code: "rate_limited",
      message: "wait",
      retry_after_seconds: 2,
      status: 429,
    });
  });
});
