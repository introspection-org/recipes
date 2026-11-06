import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { autoResolveInteractions } from "../src/interactions.js";
import {
  createIntrospectionOpenTool,
  introspectionOpenCliArgs,
  introspectionOpenExtension,
  wantsIntrospectionOpen,
  type CliRunResult,
} from "../src/introspection-open.js";
import {
  formatInteractionResume,
  INTROSPECTION_OPEN_TOOL_NAME,
  introspectionOpenTargetOf,
  parseIntrospectionOpenTarget,
} from "../src/review.js";

function fakeCtx(
  mode: "tui" | "rpc" | "print",
  selectAnswer?: string,
): { ctx: ExtensionContext; selects: string[]; notes: string[] } {
  const selects: string[] = [];
  const notes: string[] = [];
  const ui = {
    async select(title: string) {
      selects.push(title);
      return selectAnswer;
    },
    async input() {
      return undefined;
    },
    notify(message: string) {
      notes.push(message);
    },
  };
  const ctx = {
    cwd: "/tmp",
    mode,
    hasUI: mode !== "print",
    ui,
    abort() {},
  } as unknown as ExtensionContext;
  return { ctx, selects, notes };
}

function fakeCli(result: CliRunResult) {
  const calls: string[][] = [];
  return {
    calls,
    runCli: async (args: readonly string[]) => {
      calls.push([...args]);
      return result;
    },
  };
}

async function run(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  options: Parameters<typeof createIntrospectionOpenTool>[0] = {},
) {
  const tool = createIntrospectionOpenTool(options);
  const result = (await tool.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    ctx as never,
  )) as {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, any>;
  };
  return { text: result.content[0]!.text, details: result.details };
}

const github = { kind: "integration", provider: "github" };
const binding = {
  kind: "binding",
  runtime: "support",
  name: "gmail",
  environment: "staging",
};

describe("introspection_open targets", () => {
  it("keeps only the fields each kind names", () => {
    expect(
      parseIntrospectionOpenTarget({ ...binding, url: "https://evil" }),
    ).toEqual(binding);
    expect(
      parseIntrospectionOpenTarget({
        kind: "connection",
        provider: " notion ",
      }),
    ).toEqual({ kind: "connection", provider: "notion" });
    expect(parseIntrospectionOpenTarget({ kind: "url", url: "x" })).toBeNull();
    expect(
      parseIntrospectionOpenTarget({ kind: "binding", runtime: "a" }),
    ).toBeNull();
  });

  it("reads the target only from an introspection_open interrupt", () => {
    expect(
      introspectionOpenTargetOf({
        metadata: { kind: INTROSPECTION_OPEN_TOOL_NAME, target: github },
      }),
    ).toEqual(github);
    expect(
      introspectionOpenTargetOf({
        metadata: { kind: "ask_user_question", target: github },
      }),
    ).toBeNull();
  });

  it("maps each target to the CLI loopback that waits on it", () => {
    expect(
      introspectionOpenCliArgs(
        { kind: "connection", provider: "notion" },
        true,
      ),
    ).toEqual(["connectors", "authorize", "notion", "--subject", "user"]);
    expect(introspectionOpenCliArgs(github as never, true)).toEqual([
      "integrations",
      "install",
      "--type",
      "github",
      "--wait",
    ]);
    expect(introspectionOpenCliArgs(binding as never, true)).toEqual([
      "open",
      "--runtime",
      "support",
      "--wait",
    ]);
    expect(
      introspectionOpenCliArgs({ kind: "task", task: "t1" }, false),
    ).toEqual(["open", "--task", "t1"]);
    expect(
      introspectionOpenCliArgs({ kind: "sso", provider: "google" }, true),
    ).toBeNull();
  });
});

describe("introspection_open on a pause/resume host", () => {
  it("pauses with the target in the interrupt metadata and no options", async () => {
    const { ctx } = fakeCtx("print");
    const { text, details } = await run(
      { target: github, reason: "So I can open pull requests", wait: true },
      ctx,
      { env: { PI_INTERRUPT_RESUME: "1" } },
    );
    expect(text).toBe("Awaiting user response.");
    const interrupt = details.interrupt;
    expect(interrupt.outcome).toEqual({ type: "awaiting_user" });
    expect(interrupt.reason).toBe("input_required");
    expect(interrupt.message).toBe("So I can open pull requests");
    expect(interrupt.options).toBeUndefined();
    expect(interrupt.metadata).toMatchObject({
      kind: INTROSPECTION_OPEN_TOOL_NAME,
      target: github,
      action: "Install GitHub",
    });
    expect(typeof interrupt.expiresAt).toBe("string");
    expect(details.target).toEqual(github);
  });

  it("resumes with the shared envelopes", () => {
    expect(
      formatInteractionResume({
        status: "resolved",
        payload: { answer: "connected" },
      }),
    ).toBe("Answer: connected");
    expect(
      formatInteractionResume({
        status: "resolved",
        payload: { answer: "failed: access_denied" },
      }),
    ).toBe("Answer: failed: access_denied");
    expect(formatInteractionResume({ status: "cancelled" })).toBe(
      "User declined to answer. Proceed with your best judgment.",
    );
  });

  it("declines in a child agent without pausing", async () => {
    const { ctx } = fakeCtx("print");
    const { text } = await autoResolveInteractions(() =>
      run({ target: github, reason: "x", wait: true }, ctx, {
        env: { PI_INTERRUPT_RESUME: "1" },
      }),
    );
    expect(text).toBe(
      "User declined to answer. Proceed with your best judgment.",
    );
  });

  it("tells the model to ask in its reply when there is no channel", async () => {
    const { ctx } = fakeCtx("print");
    const { text } = await run(
      { target: github, reason: "x", wait: true },
      ctx,
      {
        env: {},
      },
    );
    expect(text).toContain("Ask the user in your normal assistant reply");
  });
});

describe("introspection_open in Pi's terminal", () => {
  it("answers connected when the CLI loopback succeeds", async () => {
    const { ctx, notes } = fakeCtx("tui");
    const cli = fakeCli({ code: 0, stderr: "" });
    const { text } = await run(
      {
        target: { kind: "connection", provider: "notion" },
        reason: "x",
        wait: true,
      },
      ctx,
      { env: {}, runCli: cli.runCli },
    );
    expect(cli.calls).toEqual([
      ["connectors", "authorize", "notion", "--subject", "user"],
    ]);
    expect(text).toBe("Answer: connected");
    expect(notes).toHaveLength(1);
  });

  it("answers returned for a page", async () => {
    const { ctx } = fakeCtx("tui");
    const cli = fakeCli({ code: 0, stderr: "" });
    const { text } = await run(
      {
        target: { kind: "runtime", runtime: "support" },
        reason: "x",
        wait: true,
      },
      ctx,
      { env: {}, runCli: cli.runCli },
    );
    expect(text).toBe("Answer: returned");
  });

  it("answers failed with the CLI's last error line", async () => {
    const { ctx } = fakeCtx("rpc");
    const cli = fakeCli({
      code: 1,
      stderr: "waiting...\nError: the provider said access_denied\n",
    });
    const { text } = await run(
      { target: github, reason: "x", wait: true },
      ctx,
      {
        env: {},
        runCli: cli.runCli,
      },
    );
    expect(text).toBe("Answer: failed: the provider said access_denied");
  });

  it("asks in a dialog for a target the CLI can't wait on", async () => {
    const { ctx, selects } = fakeCtx("tui", "Done");
    const cli = fakeCli({ code: 0, stderr: "" });
    const { text } = await run(
      {
        target: { kind: "sso", provider: "google" },
        reason: "Sign in with Google",
        wait: true,
      },
      ctx,
      { env: {}, runCli: cli.runCli },
    );
    expect(cli.calls).toEqual([]);
    expect(selects[0]).toContain("Set up Google sign-in");
    expect(text).toBe("Answer: connected");
  });

  it("falls back to the dialog when the CLI is missing, and declines on Not now", async () => {
    const { ctx } = fakeCtx("tui", "Not now");
    const cli = fakeCli({ code: null, stderr: "ENOENT", missing: true });
    const { text } = await run(
      { target: github, reason: "x", wait: true },
      ctx,
      {
        env: {},
        runCli: cli.runCli,
      },
    );
    expect(text).toBe(
      "User declined to answer. Proceed with your best judgment.",
    );
  });
});

describe("introspection_open without wait", () => {
  it("opens a page through the CLI and never pauses", async () => {
    const { ctx } = fakeCtx("tui");
    const cli = fakeCli({ code: 0, stderr: "" });
    const { text, details } = await run(
      { target: { kind: "task", task: "t1" }, reason: "x" },
      ctx,
      { env: { PI_INTERRUPT_RESUME: "1" }, runCli: cli.runCli },
    );
    expect(cli.calls).toEqual([["open", "--task", "t1"]]);
    expect(text).toContain("don't assume they did anything");
    expect(details.interrupt).toBeUndefined();
  });

  it("returns guidance where nothing can be opened", async () => {
    const { ctx } = fakeCtx("print");
    const { text, details } = await run({ target: github, reason: "x" }, ctx, {
      env: { PI_INTERRUPT_RESUME: "1" },
    });
    expect(text).toContain("Nothing was opened and nothing paused");
    expect(details.interrupt).toBeUndefined();
  });
});

describe("introspection_open registration", () => {
  it("registers only when listed and not already owned", async () => {
    expect(wantsIntrospectionOpen(["read", INTROSPECTION_OPEN_TOOL_NAME])).toBe(
      true,
    );
    expect(wantsIntrospectionOpen(["read"])).toBe(false);
    const registered: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool.name),
    };
    await introspectionOpenExtension(undefined, {})(pi as never);
    expect(registered).toEqual([INTROSPECTION_OPEN_TOOL_NAME]);
  });
});
