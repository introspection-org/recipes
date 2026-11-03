import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { toolCalls, type JsonValue } from "vitest-evals";
import { getHarnessRunFromError } from "vitest-evals/harness";

import { createRecipeHarness, fakesHarness, recipeCases, recipeJudge } from "./index.js";

const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeSpec(input: Record<string, unknown> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "run-spec.json");
  writeFileSync(path, JSON.stringify({
    schema_version: 2,
    runner: "vitest",
    candidate: {
      runtime: "support",
      agent: "agent",
      model: "openai/gpt-5",
    },
    input,
  }));
  process.env.INTROSPECTION_EVAL_RUN_SPEC = path;
  return directory;
}

function harnessContext() {
  const artifacts: Record<string, JsonValue> = {};
  return {
    artifacts,
    setArtifact: (name: string, value: JsonValue) => {
      artifacts[name] = value;
    },
  };
}

// The arguments before `--`; everything after it selects the run's own Pi session.
function recipeArguments(args: string[]): string[] {
  const separator = args.indexOf("--");
  expect(args.slice(separator)).toEqual([
    "--",
    "--session-dir",
    expect.stringContaining("introspection-vitest-session-"),
    "--session-id",
    expect.any(String),
  ]);
  return args.slice(0, separator);
}

// Stands in for `introspection`: logs each call's arguments and working
// directory as one JSON line, then replies with the prompt.
function recordingCli(directory: string, { failOn }: { failOn?: string } = {}): string {
  const executable = join(directory, "introspection");
  const log = join(directory, "calls.jsonl");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("--print") + 1];
let bindings = null;
try { bindings = JSON.parse(fs.readFileSync(".pi/mcp.local.json", "utf8")); } catch {}
let replay = null;
const replayPath = args.indexOf("--replay-context");
if (replayPath !== -1) replay = JSON.parse(fs.readFileSync(args[replayPath + 1], "utf8"));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), bindings, replay }) + "\\n");
if (prompt === ${JSON.stringify(failOn ?? "")}) { console.error("turn failed"); process.exit(3); }
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant",
  content: [{ type: "text", text: "reply to " + prompt }], stopReason: "stop",
  provider: "openai", model: "gpt-5",
  usage: { input: 2, output: 1, cacheRead: 5, cost: { total: 0.25 } } } }));
`,
  );
  chmodSync(executable, 0o700);
  process.env.INTROSPECTION_CLI = executable;
  delete process.env.INTROSPECTION_EVAL_RUN_SPEC;
  return log;
}

type RecordedCall = {
  args: string[];
  cwd: string;
  bindings: unknown;
  replay: { cwd: string; trajectory: unknown[] } | null;
};
const recordedCalls = (log: string): RecordedCall[] =>
  readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const piFlag = (call: RecordedCall, name: string) => call.args[call.args.indexOf(name) + 1];

describe("recipeCases", () => {
  it("loads rerunnable history and prompt cases from JSONL", () => {
    const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
    temporaryDirectories.push(directory);
    const dataset = join(directory, "support.eval.jsonl");
    writeFileSync(
      dataset,
      `${JSON.stringify({
        schema_version: 2,
        name: "follow up",
        input: {
          history: [
            { type: "message", role: "user", content: "earlier" },
            { type: "message", role: "assistant", content: "earlier answer" },
          ],
          prompt: "continue",
        },
      })}\n`,
    );

    expect(recipeCases(dataset)).toEqual([
      {
        schema_version: 2,
        name: "follow up",
        input: {
          history: [
            { type: "message", role: "user", content: "earlier" },
            { type: "message", role: "assistant", content: "earlier answer" },
          ],
          prompt: "continue",
        },
      },
    ]);
  });

  it("selects one approved contract for production replay", () => {
    writeSpec({
      prompt: "production prompt",
      metadata: { source_turn_id: "turn-2" },
    });

    const cases = recipeCases([
      {
        name: "approved contract",
        input: { prompt: "authored prompt", scenario: "fixture" },
        expected: { decision: "ask" },
      },
      {
        name: "unrelated contract",
        input: { prompt: "other authored prompt", scenario: "other" },
      },
    ]);

    expect(cases).toEqual([
      {
        name: "approved contract",
        input: {
          prompt: "production prompt",
          scenario: "fixture",
          introspectionMetadata: { source_turn_id: "turn-2" },
        },
        expected: { decision: "ask" },
      },
    ]);
  });
});

describe("createRecipeHarness", () => {
  it.runIf(process.platform !== "win32")(
    "lets introspection local discover the Recipe when run directly with Vitest",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const executable = join(directory, "introspection");
      const argumentsPath = join(directory, "arguments.txt");
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGS_PATH\"\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}],\"stopReason\":\"stop\",\"usage\":{}}}'\n",
      );
      chmodSync(executable, 0o700);
      delete process.env.INTROSPECTION_EVAL_RUN_SPEC;
      process.env.INTROSPECTION_CLI = executable;
      process.env.ARGS_PATH = argumentsPath;

      const result = await createRecipeHarness().run(
        { prompt: "say hello" },
        harnessContext(),
      );

      expect(result.output).toBe("hello");
      expect(recipeArguments(readFileSync(argumentsPath, "utf8").trim().split("\n"))).toEqual([
        "local",
        "--print",
        "say hello",
        "--mode",
        "json",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "renders application context into the model-visible user message",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const executable = join(directory, "introspection");
      const argumentsPath = join(directory, "arguments.txt");
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$ARGS_PATH\"\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"context received\"}],\"stopReason\":\"stop\",\"usage\":{}}}'\n",
      );
      chmodSync(executable, 0o700);
      delete process.env.INTROSPECTION_EVAL_RUN_SPEC;
      process.env.INTROSPECTION_CLI = executable;
      process.env.ARGS_PATH = argumentsPath;

      type AppInput = {
        prompt: string;
        systemContext: {
          entry_point: string;
          scope: string;
        };
      };
      const harness = createRecipeHarness<AppInput>({
        renderPrompt: ({ prompt, systemContext }) =>
          `${prompt}\n\n<system_context>\n${JSON.stringify(systemContext)}\n</system_context>`,
      });
      const rendered =
        'Who leads this company?\n\n<system_context>\n{"entry_point":"ask-company","scope":"global"}\n</system_context>';
      const result = await harness.run(
        {
          prompt: "Who leads this company?",
          systemContext: { entry_point: "ask-company", scope: "global" },
        },
        harnessContext(),
      );

      expect(
        recipeArguments(readFileSync(argumentsPath, "utf8").split("\0").filter(Boolean)),
      ).toEqual([
        "local",
        "--print",
        rendered,
        "--mode",
        "json",
      ]);
      expect(result.session.events[0]).toEqual({
        type: "message",
        role: "user",
        content: rendered,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "hydrates authored history and includes it in the judged transcript",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const executable = join(directory, "introspection");
      const replayCopy = join(directory, "replay.json");
      writeFileSync(
        executable,
        "#!/bin/sh\nprevious=''\nfor argument in \"$@\"; do\n  if [ \"$previous\" = '--replay-context' ]; then cp \"$argument\" \"$REPLAY_COPY\"; fi\n  previous=\"$argument\"\ndone\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"new answer\"}],\"stopReason\":\"stop\",\"usage\":{}}}'\n",
      );
      chmodSync(executable, 0o700);
      delete process.env.INTROSPECTION_EVAL_RUN_SPEC;
      process.env.INTROSPECTION_CLI = executable;
      process.env.REPLAY_COPY = replayCopy;

      const history = [
        { type: "message" as const, role: "user" as const, content: "earlier" },
        { type: "message" as const, role: "assistant" as const, content: "earlier answer" },
      ];
      const result = await createRecipeHarness().run(
        { prompt: "continue", history },
        harnessContext(),
      );

      expect(JSON.parse(readFileSync(replayCopy, "utf8"))).toEqual({
        schema_version: 2,
        cwd: process.cwd(),
        trajectory: history,
      });
      expect(result.session.events.slice(0, 3)).toEqual([
        ...history,
        { type: "message", role: "user", content: "continue" },
      ]);
    },
  );

  it("rejects ambiguous prompt renderers", () => {
    expect(() =>
      createRecipeHarness({
        renderPrompt: ({ prompt }) => prompt,
        prompt: ({ prompt }) => prompt,
      }),
    ).toThrow("renderPrompt or prompt, not both");
  });

  it.runIf(process.platform !== "win32")(
    "does not render application context over an exact production prompt",
    async () => {
      const directory = writeSpec({ prompt: "captured prompt with production context" });
      const executable = join(directory, "introspection");
      const argumentsPath = join(directory, "arguments.txt");
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$ARGS_PATH\"\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"replayed\"}],\"stopReason\":\"stop\",\"usage\":{}}}'\n",
      );
      chmodSync(executable, 0o700);
      process.env.INTROSPECTION_CLI = executable;
      process.env.ARGS_PATH = argumentsPath;

      const harness = createRecipeHarness<{
        prompt: string;
        systemContext: { scope: string };
      }>({
        renderPrompt: ({ prompt, systemContext }) =>
          `${prompt}\n\n<system_context>${systemContext.scope}</system_context>`,
      });
      const result = await harness.run(
        {
          prompt: "captured prompt with production context",
          systemContext: { scope: "fixture" },
        },
        harnessContext(),
      );

      expect(readFileSync(argumentsPath, "utf8").split("\0").filter(Boolean)).toContain(
        "captured prompt with production context",
      );
      expect(result.session.events[0]).toEqual({
        type: "message",
        role: "user",
        content: "captured prompt with production context",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "normalizes Recipe output, scoped tools, usage, and custom artifacts",
    async () => {
      const directory = writeSpec();
      const executable = join(directory, "introspection");
      const argumentsPath = join(directory, "arguments.txt");
      const lines = [
        {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5",
            content: [
              { type: "text", text: "root answer" },
              {
                type: "toolCall",
                id: "same-id",
                name: "profiles_get",
                arguments: { profile_id: "person-1" },
              },
            ],
            usage: {
              input: 10,
              output: 4,
              cacheRead: 2,
              cost: { total: 0.01 },
            },
          },
        },
        {
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: "same-id",
            content: { id: "person-1" },
          },
        },
        {
          type: "entry_appended",
          entry: {
            type: "custom",
            customType: "agent_run_event",
            data: {
              type: "agent_run_event",
              agent_run_id: "child-1",
              parent_agent_run_id: "root",
              agent_name: "researcher",
              invocation_name: "researcher",
              depth: 1,
              event: {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "same-id",
                      name: "read",
                      arguments: { path: "notes.md" },
                    },
                  ],
                  usage: { input: 3, output: 2 },
                },
              },
            },
          },
        },
      ].map((line) => JSON.stringify(line));
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "$ARGS_PATH"\n${lines.map((line) => `printf '%s\\n' '${line}'`).join("\n")}\n`,
      );
      chmodSync(executable, 0o700);
      process.env.INTROSPECTION_CLI = executable;
      process.env.ARGS_PATH = argumentsPath;

      const lifecycle: string[] = [];
      const harness = createRecipeHarness<{
        prompt: string;
        scenario: string;
      }>({
        beforeRun: ({ input }) => {
          lifecycle.push(`reset:${input.scenario}`);
        },
        collectArtifacts: ({ result }) => ({
          fixture: { calls: result.toolCalls.length },
        }),
      });

      const result = await harness.run(
        { prompt: "inspect the profile", scenario: "direct-profile" },
        harnessContext(),
      );

      expect(lifecycle).toEqual(["reset:direct-profile"]);
      expect(result.output).toBe("root answer");
      expect(result.usage).toEqual({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 13,
        outputTokens: 6,
        totalTokens: 19,
        toolCalls: 2,
        metadata: { cachedTokens: 2, costUsd: 0.01 },
      });
      expect(toolCalls(result)).toEqual([
        expect.objectContaining({
          name: "profiles_get",
          status: "ok",
          result: { id: "person-1" },
        }),
        expect.objectContaining({
          name: "read",
          status: "pending",
        }),
      ]);
      expect(result.artifacts).toEqual(
        expect.objectContaining({ fixture: { calls: 2 } }),
      );
      expect(result.session.events).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          id: "child-1:same-id",
          metadata: expect.objectContaining({
            run: expect.objectContaining({ id: "child-1", depth: 1 }),
          }),
        }),
      );

      const args = recipeArguments(readFileSync(argumentsPath, "utf8").trim().split("\n"));
      expect(args).toEqual([
        "local",
        "--runtime",
        "support",
        "--agent",
        "agent",
        "--print",
        "inspect the profile",
        "--mode",
        "json",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a terminal Recipe error",
    async () => {
      const directory = writeSpec();
      const executable = join(directory, "introspection");
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"Provider authentication failed\",\"usage\":{}}}'\n",
      );
      chmodSync(executable, 0o700);
      process.env.INTROSPECTION_CLI = executable;

      const harness = createRecipeHarness();
      await expect(
        harness.run({ prompt: "hello" }, harnessContext()),
      ).rejects.toThrow("Provider authentication failed");
    },
  );
});

describe("recipeJudge", () => {
  it.runIf(process.platform !== "win32")(
    "resolves a Recipe judge by name through the CLI and scores its verdict",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const executable = join(directory, "introspection");
      const argumentsPath = join(directory, "arguments.txt");
      const inputPath = join(directory, "judge-input.json");
      writeFileSync(
        executable,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGS_PATH\"\ncat > \"$INPUT_PATH\"\nprintf '%s\\n' '{\"schema_version\":1,\"judge\":\"deepwiki-used-correctly\",\"provider\":\"openai\",\"model\":\"gpt-5\",\"verdict\":\"pass\",\"reasoning\":\"DeepWiki evidence was used correctly.\"}'\n",
      );
      chmodSync(executable, 0o700);
      process.env.INTROSPECTION_CLI = executable;
      process.env.ARGS_PATH = argumentsPath;
      process.env.INPUT_PATH = inputPath;

      const judge = recipeJudge("deepwiki-used-correctly", (run) => ({
        runtimeSlug: "recruitment-pipeline",
        conversationId: String(run.artifacts?.conversationId),
      }));
      const session = {
        events: [
          {
            type: "message" as const,
            role: "system" as const,
            content: "Use primary repository evidence.",
          },
          { type: "message" as const, role: "user" as const, content: "Research Sentry" },
          {
            type: "tool_call" as const,
            id: "call-1",
            name: "bash",
            arguments: {
              command:
                "mcp call deepwiki.ask_question repoName=getsentry/sentry question='How are errors ingested?'",
            },
          },
          {
            type: "tool_result" as const,
            toolCallId: "call-1",
            name: "bash",
            content: "Relay accepts and normalizes events.",
          },
          {
            type: "message" as const,
            role: "assistant" as const,
            content: "Sentry processes events through Relay.",
          },
        ],
      };
      const result = await judge.assess({
        input: { prompt: "Research Sentry" },
        output: "Sentry processes events through Relay.",
        toolCalls: [],
        run: {
          output: "Sentry processes events through Relay.",
          session,
          usage: { model: "gpt-5" },
          timings: {},
          artifacts: { conversationId: "evaluated-conversation" },
          errors: [],
        },
        session,
        harness: createRecipeHarness(),
      } as never);

      expect(result).toEqual({
        score: 1,
        metadata: expect.objectContaining({
          rationale: "DeepWiki evidence was used correctly.",
        }),
      });
      expect(readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
        "judges",
        "evaluate",
        "--judge",
        "deepwiki-used-correctly",
        "--runtime-slug",
        "recruitment-pipeline",
        "--conversation-id",
        "evaluated-conversation",
        "--input",
        "-",
        "--output",
        "json",
      ]);
      const input = JSON.parse(readFileSync(inputPath, "utf8"));
      expect(input).toMatchObject({
        schema_version: 2,
        system_instructions: "Use primary repository evidence.",
      });
      expect(input.trajectory).toContainEqual(
        expect.objectContaining({ type: "tool_call", id: "call-1", name: "bash" }),
      );
      expect(input).not.toHaveProperty("feedback_events");
      expect(input.trajectory.every((event: { timestamp?: string }) => !event.timestamp)).toBe(
        true,
      );
    },
  );
});

describe("continued runs", () => {
  it.runIf(process.platform !== "win32")(
    "sends the next turn in the same Pi session and reports the whole conversation",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const log = recordingCli(directory);
      const prepared: string[] = [];
      const harness = createRecipeHarness({
        beforeRun: ({ prompt }) => {
          prepared.push(prompt);
        },
      });

      const review = await harness.run({ prompt: "draft it" }, harnessContext());
      const sent = await harness.run(
        { prompt: "approved, send it", continue: review },
        harnessContext(),
      );

      const [first, second] = recordedCalls(log);
      expect(piFlag(second, "--session-id")).toBe(piFlag(first, "--session-id"));
      expect(piFlag(second, "--session-dir")).toBe(piFlag(first, "--session-dir"));
      expect(second.args).not.toContain("--replay-context");
      // The session is prepared once, by its first turn.
      expect(prepared).toEqual(["draft it"]);

      expect(review.session.events.map((event) => (event as { content: string }).content))
        .toEqual(["draft it", "reply to draft it"]);
      expect(sent.output).toBe("reply to approved, send it");
      expect(sent.session.events.map((event) => (event as { content: string }).content)).toEqual([
        "draft it",
        "reply to draft it",
        "approved, send it",
        "reply to approved, send it",
      ]);
      expect(review.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
      expect(sent.usage).toMatchObject({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 4,
        outputTokens: 2,
        metadata: { cachedTokens: 10, costUsd: 0.5 },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the earlier turns on a failed continued turn",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      recordingCli(directory, { failOn: "approved, send it" });
      const harness = createRecipeHarness();
      const review = await harness.run({ prompt: "draft it" }, harnessContext());

      const failure = await harness
        .run({ prompt: "approved, send it", continue: review }, harnessContext())
        .catch((error: unknown) => error);

      expect(String(failure)).toContain("introspection local exited 3");
      const partial = getHarnessRunFromError(failure);
      expect(partial?.session.events.map((event) => (event as { content: string }).content))
        .toEqual(["draft it", "reply to draft it", "approved, send it"]);
      expect(partial?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "leaves a replaying turn in the session introspection local hydrates",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const log = recordingCli(directory);
      const harness = createRecipeHarness();

      const replayed = await harness.run(
        {
          prompt: "continue",
          history: [{ type: "message", role: "user", content: "earlier" }],
        },
        harnessContext(),
      );

      // Pi rejects `--session-id` beside the `--session` a replay is hydrated into.
      const [call] = recordedCalls(log);
      expect(call.args).toContain("--replay-context");
      expect(call.args).not.toContain("--session-id");
      expect(call.args).not.toContain("--session-dir");
      await expect(
        harness.run({ prompt: "next", continue: replayed }, harnessContext()),
      ).rejects.toThrow("A run that replays history cannot be continued");
    },
  );

  it("refuses a run that is not an open session of this test", async () => {
    const harness = createRecipeHarness();
    await expect(
      harness.run({ prompt: "next", continue: { artifacts: {} } }, harnessContext()),
    ).rejects.toThrow("input.continue must be an earlier run of the same test");
  });
});

describe("per-run environment", () => {
  it.runIf(process.platform !== "win32")(
    "binds only the declared MCP servers, outside the Recipe checkout",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const log = recordingCli(directory);
      const servers = [{ id: "crm", transport: "streamable_http", url: "http://127.0.0.1:1/mcp" }];
      const harness = createRecipeHarness({
        beforeRun: () => ({ mcpServers: servers }),
      });

      const first = await harness.run({ prompt: "one" }, harnessContext());
      await harness.run({ prompt: "two", continue: first }, harnessContext());

      const [call, continued] = recordedCalls(log);
      expect(call.bindings).toEqual({ servers });
      expect(call.cwd).not.toBe(process.cwd());
      expect(piFlag(call, "--work-dir")).toBe(process.cwd());
      expect(call.args.slice(call.args.indexOf("--"))).toContain("--approve");
      // A continued turn runs against the same bindings.
      expect(continued.cwd).toBe(call.cwd);
      expect(continued.bindings).toEqual({ servers });
    },
  );

  it.runIf(process.platform !== "win32")(
    "replays history in the bound directory, not in the Recipe checkout",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const log = recordingCli(directory);
      const servers = [{ id: "crm", url: "http://127.0.0.1:1/mcp" }];
      const harness = createRecipeHarness({ beforeRun: () => ({ mcpServers: servers }) });
      const history = [{ type: "message" as const, role: "user" as const, content: "earlier" }];

      // Pi resumes a hydrated session where its context says, and reads the
      // project-local MCP bindings of that directory.
      await harness.run({ prompt: "authored history", history }, harnessContext());

      const supplied = join(directory, "production.json");
      writeFileSync(
        supplied,
        JSON.stringify({ schema_version: 2, cwd: process.cwd(), trajectory: history }),
      );
      writeSpec({ replay_context_path: supplied });
      process.env.INTROSPECTION_CLI = join(directory, "introspection");
      await harness.run({ prompt: "production replay" }, harnessContext());

      for (const call of recordedCalls(log)) {
        expect(call.bindings).toEqual({ servers });
        expect(call.replay?.trajectory).toEqual(history);
        // The child reports its real path; the temporary directory may be a symlink.
        expect(realpathSync(call.replay?.cwd ?? "")).toBe(realpathSync(call.cwd));
        expect(call.cwd).not.toBe(process.cwd());
      }
      expect(JSON.parse(readFileSync(supplied, "utf8")).cwd).toBe(process.cwd());
    },
  );

  it.runIf(process.platform !== "win32")(
    "hands the fixture to collectArtifacts, also when the turn fails",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      recordingCli(directory, { failOn: "break" });
      const harness = createRecipeHarness<{ prompt: string }, { name: string }>({
        beforeRun: () => ({ fixture: { name: "fakes" } }),
        collectArtifacts: ({ fixture, result }) => ({
          fixture: fixture.name,
          completed: result !== undefined,
        }),
      });

      const passed = await harness.run({ prompt: "work" }, harnessContext());
      expect(passed.artifacts).toMatchObject({ fixture: "fakes", completed: true });

      const failure = await harness
        .run({ prompt: "break" }, harnessContext())
        .catch((error: unknown) => error);
      expect(getHarnessRunFromError(failure)?.artifacts).toMatchObject({
        fixture: "fakes",
        completed: false,
      });
    },
  );
});

// One session per describe: its teardown must run when the first test finishes.
describe("session teardown", () => {
  const torndown: string[] = [];
  let continuable: Awaited<ReturnType<ReturnType<typeof createRecipeHarness>["run"]>>;
  let harness: ReturnType<typeof createRecipeHarness>;

  it.runIf(process.platform !== "win32")("keeps the session open during the test", async () => {
    const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
    temporaryDirectories.push(directory);
    recordingCli(directory);
    harness = createRecipeHarness({
      beforeRun: () => ({ teardown: () => void torndown.push("closed") }),
    });
    continuable = await harness.run({ prompt: "one" }, harnessContext());
    await harness.run({ prompt: "two", continue: continuable }, harnessContext());
    expect(torndown).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("tears down once when the test finishes", async () => {
    expect(torndown).toEqual(["closed"]);
    await expect(
      harness.run({ prompt: "three", continue: continuable }, harnessContext()),
    ).rejects.toThrow("its Pi session is no longer open");
  });
});


describe("fakesHarness", () => {
  type World = { crm: { deals: string[] } };
  // A fake with no tools that hands the test the state it serves.
  const served: World["crm"][] = [];
  const fakes = {
    crm: {
      manifest: { server: { name: "crm", version: "1.0.0" }, tools: {} },
      register: (_server: unknown, state: World["crm"]) => void served.push(state),
    },
  };
  const world = (scenario: string | undefined): World => ({
    crm: { deals: scenario === "empty" ? [] : ["acme"] },
  });

  it.runIf(process.platform !== "win32")(
    "binds fresh fakes to every session and records their states",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "introspection-vitest-evals-test-"));
      temporaryDirectories.push(directory);
      const log = recordingCli(directory);
      const harness = fakesHarness({
        fakes,
        world,
        scenario: (input) => input.scenario as string | undefined,
        collectArtifacts: ({ fixture }) => ({ deals: fixture.states.crm.deals.length }),
      });

      const first = await harness.run({ prompt: "one" }, harnessContext());
      served.at(-1)?.deals.push("beacon");
      const continued = await harness.run({ prompt: "two", continue: first }, harnessContext());
      await harness.run({ prompt: "three", scenario: "empty" }, harnessContext());

      expect(first.artifacts).toMatchObject({
        fakeStates: { initial: { crm: { deals: ["acme"] } }, final: { crm: { deals: ["acme"] } } },
        deals: 1,
      });
      expect(continued.artifacts).toMatchObject({
        fakeStates: {
          initial: { crm: { deals: ["acme"] } },
          final: { crm: { deals: ["acme", "beacon"] } },
        },
        deals: 2,
      });
      const [one, two, three] = recordedCalls(log);
      const url = (call: RecordedCall) =>
        (call.bindings as { servers: { id: string; url: string }[] }).servers[0];
      expect(url(one)).toEqual({
        id: "crm",
        transport: "streamable_http",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/crm\/mcp$/),
      });
      // A continued turn keeps its session's fakes; a new session starts its own.
      expect(url(two)).toEqual(url(one));
      expect(url(three).url).not.toBe(url(one).url);
      const health = new URL("/health", url(three).url);
      expect(await fetch(health).then((response) => response.json())).toEqual({ ok: true });
    },
  );
});
