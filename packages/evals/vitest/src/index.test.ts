import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { toolCalls, type JsonValue } from "vitest-evals";

import { createRecipeHarness, recipeCases, recipeJudge } from "./index.js";

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
      expect(readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
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

      expect(readFileSync(argumentsPath, "utf8").split("\0").filter(Boolean)).toEqual([
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

      const args = readFileSync(argumentsPath, "utf8").trim().split("\n");
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

      const judge = recipeJudge("deepwiki-used-correctly");
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
          artifacts: {},
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
